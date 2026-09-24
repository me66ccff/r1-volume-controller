/**
 * 屏外连接桥：长期持有唯一一条与 R1 音箱的 WebSocket 连接。
 *
 * 协议（来自 r1-ctrl.js 与官方 r1_control.min.js）：
 *   请求 {type:'get_info'}    -> {type:'get_info', data:'{...}'}  data 是 JSON 字符串
 *   请求 {type:'max_vol'}     -> {type:'max_vol', code:200, data:15}
 *   请求 {type:'set_vol',vol:n}（无响应，需再 get_info 回读）
 *   其它可用: {type:'send_message', what:4|5|3, ...} 播放控制 / {type:'reboot_echo'}
 */
(function () {
  'use strict';

  /**
   * 启动即自报家门：这是「文档到底有没有跑起来」的唯一可靠证据。
   * 之前这里全程静默 —— 文档被创建后立刻自己退出，service worker 只能看到
   * 「文档数 0、握手无人应答」，完全查不出原因。现在无论成败都会留一句话。
   */
  function report(line, detail) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
      var p = chrome.runtime.sendMessage({
        target: 'background',
        type: 'offscreen/boot',
        line: line,
        detail: detail || ''
      });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      /* 连报信都做不到，只能算了 */
    }
  }

  /** 给 Promise 加超时：启动流程里任何一步都不能无限等待 */
  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise(function (resolve, reject) {
        setTimeout(function () {
          reject(new Error(message || '超时'));
        }, ms);
      })
    ]);
  }

  report('脚本开始执行');

  /**
   * 扩展重新加载 / 更新后，上一个版本创建的屏幕外文档可能还活着，
   * 但它的扩展上下文已经失效：此时 chrome.runtime 是 undefined。
   * 注意：判断依据只看 runtime！
   * 实测有些环境（某些 Chrome 版本的屏幕外文档）里 chrome.storage 就是不可用，
   * 早期版本把 storage 也当成必要条件，结果把好好的连接桥判成「上下文失效」直接自杀，
   * 表现就是「文档被创建后立刻消失、握手永远没人应答」。storage 缺失只降级，不致命。
   */
  var storage = (typeof chrome !== 'undefined' && chrome.storage) || null;
  var runtime = (typeof chrome !== 'undefined' && chrome.runtime) || null;

  function contextAlive() {
    return !!(runtime && runtime.id);
  }

  // 上下文失效时把噪音日志也一起掐掉（此时任何扩展 API 调用都会抛）
  var rawError = console.error.bind(console);
  console.error = function () {
    var text = Array.prototype.join.call(arguments, ' ');
    if (!contextAlive() && /context invalidated|Cannot read properties|undefined/i.test(text)) return;
    rawError.apply(null, arguments);
  };

  if (!contextAlive()) {
    report('上下文失效，即将退出', {
      hasStorage: !!storage,
      hasRuntime: !!runtime,
      runtimeId: runtime ? String(runtime.id || '') : '(no runtime)'
    });
    try {
      window.close(); // 让 service worker 下次唤醒时创建一个全新的连接桥
    } catch (e) {
      /* ignore */
    }
    return;
  }

  // 启动期的任何异常都要报回去，否则文档会静默消失
  // （这段必须自带 try：某些环境没有 addEventListener，抛出去会把整个初始化钩子带崩）
  try {
    self.addEventListener('error', function (event) {
      report('启动期未捕获错误', (event && event.message) || '');
    });
  } catch (e) {
    /* 没有 addEventListener 就算了，不影响主流程 */
  }

  var C = self.R1;
  if (!C) {
    report('constants.js 未加载（self.R1 不存在），即将退出');
    return;
  }
  report('依赖就绪，开始初始化');
  var PING_INTERVAL = 20000;

  var settings = Object.assign({}, C.DEFAULT_SETTINGS);
  var state = {
    status: 'disabled', // disabled | connecting | online | offline | error
    device: C.emptyDevice(),
    lastError: '',
    attempts: 0,
    lastSeen: 0,
    updatedAt: Date.now()
  };

  var socket = null;
  var waiting = []; // 等待设备响应的队列
  var reconnectTimer = null;
  var pingTimer = null;
  var refreshing = false;
  var wanted = false; // 是否希望保持连接
  var lastNonZero = null;

  /** 连接桥自检信息：会随状态一起广播给 service worker，界面能显示出来 */
  var health = {
    startedAt: Date.now(),
    nonce: '',
    handled: 0,
    lastHandled: '',
    lastHandledAt: 0,
    lastThrow: '',
    socketOpens: 0,
    socketCloses: 0,
    lastCloseCode: null,
    lastSent: '',
    lastSentAt: 0
  };

  /* ------------------------------------------------------------------ 状态广播 */

  var broadcastTimer = null;
  // 本连接桥自己的会话标识（见 broadcast 里的说明）
  var token = 'off-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  function broadcast(immediate) {
    if (broadcastTimer) {
      if (!immediate) return;
      clearTimeout(broadcastTimer);
    }
    var fire = function () {
      broadcastTimer = null;
      state.updatedAt = Date.now();
      // 会话标识：service worker 只接受属于自己会话的状态，避免旧 worker 遗留的连接桥
      // 让新 worker 误以为「已连接」。
      // 注意：标识由连接桥自己生成 —— 不能等 service worker 的 hello 来给，
      // 否则一个「更早版本创建、不认识 hello」的文档会把状态全部丢掉（实测到过）。
      // 若 service worker 送来它自己的标识，就以它的为准。
      var session = self.__r1Nonce || token;
      try {
        var p = runtime.sendMessage({
          target: 'background',
          type: 'offscreen/state',
          state: state,
          health: health,
          session: session
        });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {
        /* service worker 可能正在重启，忽略 */
      }
    };
    if (immediate) fire();
    else broadcastTimer = setTimeout(fire, 60);
  }

  /* ------------------------------------------------------------------ 请求/响应 */

  function sendRaw(type, extra, timeout) {
    return new Promise(function (resolve, reject) {
      if (!socket || socket.readyState !== 1) {
        reject(new Error('未连接'));
        return;
      }
      var msg = Object.assign({ type: type }, extra || {});
      var entry = {
        type: type,
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          var i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error('等待设备响应超时'));
        }, timeout || C.REQUEST_TIMEOUT)
      };
      waiting.push(entry);
      try {
        socket.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(entry.timer);
        var i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        reject(e);
      }
    });
  }

  function settleAll(err) {
    var list = waiting;
    waiting = [];
    list.forEach(function (entry) {
      clearTimeout(entry.timer);
      entry.reject(err || new Error('连接已断开'));
    });
  }

  function onMessage(event) {
    var msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch (e) {
      return;
    }
    if (!msg || !msg.type) return;

    var match = -1;
    for (var i = 0; i < waiting.length; i++) {
      if (waiting[i].type === msg.type) {
        match = i;
        break;
      }
    }
    if (match < 0) {
      // 没有等待者，说明这是心跳 get_info 的回包：顺手刷新一下状态
      if (msg.type === 'get_info' && !refreshing) {
        var data = C.parseMaybeJson(msg.data);
        if (data && typeof data === 'object' && typeof data.vol === 'number') {
          applyRaw(data);
          state.lastSeen = Date.now();
          broadcast(false);
        }
      }
      return;
    }

    var entry = waiting.splice(match, 1)[0];
    clearTimeout(entry.timer);
    if (typeof msg.code === 'number' && msg.code !== 200 && msg.code !== 1) {
      entry.reject(new Error(msg.msg || ('设备返回 code ' + msg.code)));
      return;
    }
    entry.resolve(msg);
  }

  /** 取设备原始信息（JSON 字符串） */
  function fetchInfo() {
    return sendRaw('get_info').then(function (msg) {
      var data = C.parseMaybeJson(msg.data);
      if (typeof data === 'string') {
        throw new Error('设备信息格式异常');
      }
      return data;
    });
  }

  function fetchMax() {
    return sendRaw('max_vol', null, 2500).then(function (msg) {
      var v = C.parseMaybeJson(msg.data);
      var n = Math.round(Number(v));
      return isFinite(n) && n > 0 ? n : null;
    });
  }

  /* ------------------------------------------------------------------ 状态同步 */

  function markSyncing(on) {
    if (state.syncing === on) return;
    state.syncing = on;
    broadcast(true);
  }

  /** 回读设备真实音量并广播，所有指令最终都收敛到这一步 */
  function refresh(force) {
    if (!wanted) return Promise.resolve(state);
    if (refreshing) {
      if (force) scheduleRefresh(400);
      return Promise.resolve(state);
    }
    if (!socket || socket.readyState !== 1) {
      connect();
      return Promise.resolve(state);
    }
    if (!force && Date.now() - state.lastSeen < C.FRESH_WINDOW) {
      return Promise.resolve(state);
    }

    refreshing = true;
    markSyncing(true);

    var jobs = [fetchInfo()];
    if (state.device.max === C.DEFAULT_MAX_VOL && !state.gotMax) jobs.push(fetchMax());

    return Promise.all(jobs)
      .then(function (res) {
        var raw = res[0];
        if (res[1]) {
          state.device.max = res[1];
          state.gotMax = true;
        }
        applyRaw(raw);
        state.lastError = '';
        state.attempts = 0;
        state.lastSeen = Date.now();
        state.syncing = false;
        broadcast(true);
      })
      .catch(function (err) {
        state.lastError = err && err.message ? err.message : String(err);
      })
      .then(function () {
        refreshing = false;
        markSyncing(false);
        broadcast(true);
        return state;
      });
  }

  var refreshTimer = null;
  function scheduleRefresh(delay) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      refresh(true);
    }, delay);
  }

  function applyRaw(raw) {
    var next = C.normalizeDevice(raw, state.device);
    next.online = true;
    next.host = state.device.host;
    next.muted = next.vol === 0;
    if (next.vol > 0) lastNonZero = next.vol;
    state.device = next;
  }

  /* ------------------------------------------------------------------ 连接管理 */

  function status(s, err) {
    var changed = state.status !== s || (err !== undefined && state.lastError !== (err || ''));
    state.status = s;
    if (err !== undefined) state.lastError = err || '';
    if (changed) broadcast(true);
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function connect() {
    if (!wanted) return;
    var host = C.hostOf(settings.ip);
    if (!host) {
      status('disabled');
      return;
    }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

    clearTimers();
    status('connecting');
    state.device.host = host;
    broadcast(true);

    var url = C.wsUrl(host);
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      status('error', '无法创建连接: ' + e.message);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = function () {
      if (socket !== ws) return;
      health.socketOpens += 1;
      state.attempts = 0;
      status('online');
      state.gotMax = false;
      pingTimer = setInterval(function () {
        if (socket === ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ type: 'get_info' }));
          } catch (e) {
            /* ignore */
          }
        }
      }, PING_INTERVAL);
      refresh(true);
    };

    ws.onmessage = onMessage;

    ws.onerror = function () {
      if (socket !== ws) return;
      state.lastError = '无法连接 ' + host + ':' + C.R1_PORT;
    };

    ws.onclose = function (event) {
      if (socket !== ws) return; // 已被新连接/主动断开接管
      health.socketCloses += 1;
      health.lastCloseCode = event && typeof event.code === 'number' ? event.code : null;
      socket = null;
      clearTimers();
      settleAll(new Error('连接已断开'));
      if (!wanted) return;
      if (state.device.online) state.device.online = false;
      if (event && event.code === 1006) {
        state.lastError = '连接被拒绝：请确认音箱 IP 与 EchoService 是否正常';
      }
      status('offline', state.lastError);
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (!wanted) return;
    if (reconnectTimer) return;
    var delay = Math.min(30000, 900 * Math.pow(1.6, Math.min(state.attempts, 8)));
    state.attempts += 1;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function disconnect(reason) {
    wanted = false;
    clearTimers();
    settleAll(new Error('已断开'));
    if (socket) {
      var ws = socket;
      socket = null;
      try {
        ws.close(1000, 'user');
      } catch (e) {
        /* ignore */
      }
    }
    state.device = Object.assign(C.emptyDevice(), { host: C.hostOf(settings.ip) });
    state.gotMax = false;
    status('disabled', reason || '');
    broadcast(true);
  }

  function configure(nextIp, auto) {
    var host = C.hostOf(nextIp);
    var changed = host !== C.hostOf(settings.ip);
    settings.ip = host;
    if (typeof auto === 'boolean') wanted = auto;
    if (!host) {
      disconnect('未设置音箱地址');
      return Promise.resolve(state);
    }
    if (changed || !socket || socket.readyState > 1) {
      if (socket) {
        var ws = socket;
        socket = null;
        try {
          ws.close(1000, 'switch');
        } catch (e) {
          /* ignore */
        }
      }
      clearTimers();
      settleAll(new Error('切换设备'));
      state.device = Object.assign(C.emptyDevice(), { host: host });
      state.gotMax = false;
      state.lastSeen = 0;
      wanted = true;
      state.attempts = 0;
      connect();
      return Promise.resolve(state);
    }
    wanted = true;
    connect();
    return Promise.resolve(state);
  }

  /* ------------------------------------------------------------------ 指令处理 */

  function ensureConnected() {
    if (!C.hostOf(settings.ip)) {
      return Promise.reject(new Error('还没有设置音箱 IP，请先在设置里填写'));
    }
    wanted = true;
    if (!socket || socket.readyState > 1) {
      connect();
      return new Promise(function (resolve, reject) {
        var deadline = Date.now() + 6000;
        (function poll() {
          if (socket && socket.readyState === 1) return resolve();
          if (Date.now() > deadline) return reject(new Error('连接音箱超时'));
          setTimeout(poll, 120);
        })();
      });
    }
    if (socket.readyState === 0) {
      return new Promise(function (resolve, reject) {
        var deadline = Date.now() + 6000;
        (function poll() {
          if (socket && socket.readyState === 1) return resolve();
          if (Date.now() > deadline) return reject(new Error('连接音箱超时'));
          setTimeout(poll, 120);
        })();
      });
    }
    return Promise.resolve();
  }

  function send(message) {
    return ensureConnected().then(function () {
      try {
        socket.send(JSON.stringify(message));
      } catch (e) {
        throw new Error('指令发送失败: ' + e.message);
      }
      return true;
    });
  }

  function remoteAction(name) {
    var map = {
      play: { what: 4, arg1: 24, arg2: 1, obj: true },
      pause: { what: 5, arg1: 25, arg2: 1, obj: true },
      next: { what: 4, arg1: 19, arg2: 1, obj: true },
      prev: { what: 4, arg1: 20, arg2: 1, obj: true }
    };
    var payload = map[name];
    if (!payload && name === 'reboot') {
      return send({ type: 'reboot_echo' }).then(function () {
        setTimeout(function () {
          try {
            if (socket && socket.readyState === 1) socket.close(1000, 'reboot');
          } catch (e) {
            /* ignore */
          }
        }, 600);
        return true;
      });
    }
    if (!payload) throw new Error('未知操作: ' + name);
    return send(Object.assign({ type: 'send_message' }, payload)).then(function () {
      scheduleRefresh(1200);
      return true;
    });
  }

  /** 设置音量：指令 + 回读，保证界面显示的是设备真实值 */
  function setVolume(value) {
    var max = state.device.max || C.DEFAULT_MAX_VOL;
    var target = C.clamp(value, 0, max);
    var previous = state.device.vol;

    // 记住「静音前」的音量必须用设备真实值。
    // service worker 为了界面秒响应会先做乐观更新，但它写的是同一份广播状态，
    // 所以这里绝不能相信 state.device.vol 还是旧值。
    if (previous > (state.device.min || 0)) lastNonZero = previous;

    // 乐观更新，界面立刻响应
    state.device.vol = target;
    state.device.muted = target === 0;
    if (target > 0) lastNonZero = target;
    broadcast(true);

    return send({ type: 'set_vol', vol: target })
      .then(function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, C.SETTLE_MS);
        });
      })
      .then(function () {
        return refresh(true);
      })
      .then(function () {
        // 设备没接受（比如被钳制到上限），以回读值为准；
        // lastNonZero 只能记设备真实接受过的音量，否则「取消静音」会恢复一个从未存在过的值
        var real = state.device.vol;
        if (Math.abs(real - target) > 1) {
          if (real > 0) lastNonZero = real;
        }
        return { vol: state.device.vol, max: state.device.max, previous: previous, requested: target };
      });
  }

  /** 相对增减，返回最终结果 */
  function bump(delta) {
    var max = state.device.max || C.DEFAULT_MAX_VOL;
    var base = state.device.vol;
    if (delta > 0 && base === 0 && lastNonZero) base = Math.max(0, lastNonZero - delta);
    var target = C.clamp(base + delta, 0, max);
    if (target === state.device.vol && delta !== 0) {
      return Promise.resolve({ vol: state.device.vol, max: max, unchanged: true });
    }
    return setVolume(target);
  }

  /**
   * 静音开关：点一下降到设备能接受的最低音量，再点一下恢复。
   *
   * 官方协议里没有静音指令，只有 set_vol，所以「静音」只能靠写到最低档实现。
   * 有的固件会把 0 钳成 1，因此这里先探测出设备真正的「静音档位」并记下来，
   * 界面也以这个档位判断是否处于静音，而不是死认 vol === 0。
   */
  function setMute(mute) {
    var max = state.device.max || C.DEFAULT_MAX_VOL;
    var floor = state.device.min || 0;

    if (!mute) {
      // 恢复：优先用「静音前记住的音量」，其次用最后一次非零音量，最后兜底
      var remembered =
        state.device.muteRestore && state.device.muteRestore > floor
          ? state.device.muteRestore
          : lastNonZero && lastNonZero > floor
            ? lastNonZero
            : Math.max(1, Math.round(max / 3));
      return setVolume(remembered).then(function (r) {
        state.device.muteRestore = null;
        r.muted = r.vol <= state.device.min;
        return r;
      });
    }

    // 静音：先把当前音量记下来（必须用设备真实值，不能相信乐观更新过的状态）
    var from = state.device.vol;
    if (from > floor) {
      state.device.muteRestore = from;
      lastNonZero = from;
    }

    return setVolume(0).then(function (r) {
      if (r.vol <= 0) {
        state.device.min = 0;
        r.muted = true;
        return r;
      }
      // 设备不认 0（钳到了 1 之类），隔一会儿再试一次：部分固件首次会吞掉这一帧
      return new Promise(function (resolve) {
        setTimeout(resolve, 250);
      })
        .then(function () {
          return setVolume(0);
        })
        .then(function (r2) {
          if (r2.vol <= 0) {
            state.device.min = 0;
            r2.muted = true;
            r2.label = '已静音';
            return r2;
          }
          // 设备的最低档就是它了，把这一档当作静音来用
          state.device.min = r2.vol;
          r2.muted = true;
          r2.label = '已降到最低音量 ' + r2.vol;
          r2.downgraded = true;
          broadcast(true);
          return r2;
        });
    });
  }

  /* ------------------------------------------------------------------ 消息入口 */

  var HANDLERS = {
    get_state: function () {
      return Promise.resolve(state);
    },
    connect: function () {
      return configure(settings.ip, true).then(function () {
        return refresh(true);
      });
    },
    disconnect: function () {
      disconnect('已断开连接');
      return Promise.resolve(state);
    },
    configure: function (msg) {
      var host = C.hostOf(msg.ip);
      if (host && !C.isLikelyIp(host)) {
        return Promise.reject(new Error('IP 格式不正确: ' + msg.ip));
      }
      return configure(host, msg.auto !== false);
    },
    set_vol: function (msg) {
      return setVolume(Number(msg.vol));
    },
    bump: function (msg) {
      return bump(Number(msg.delta) || 0);
    },
    set_mute: function (msg) {
      return setMute(!!msg.mute);
    },
    set_max: function (msg) {
      var n = Math.round(Number(msg.max));
      if (isFinite(n) && n > 0 && n <= 60) {
        state.device.max = n;
        state.gotMax = true;
        broadcast(true);
      }
      return Promise.resolve(state);
    },
    refresh: function () {
      return refresh(true);
    },
    play: function () {
      return remoteAction('play');
    },
    pause: function () {
      return remoteAction('pause');
    },
    next: function () {
      return remoteAction('next');
    },
    prev: function () {
      return remoteAction('prev');
    },
    reboot: function () {
      return remoteAction('reboot');
    },
    /**
     * 握手：service worker 每次启动都会带一个本次实例独有的 nonce 来探测。
     * 由本次实例创建的连接桥会把它记下来（见下面的 hello），旧版本遗留的僵尸文档
     * 不知道这个 nonce，于是会被识别出来并重建。
     */
    hello: function (msg) {
      if (msg.nonce) self.__r1Nonce = String(msg.nonce);
      return Promise.resolve({
        nonce: self.__r1Nonce || '',
        token: token,
        origin: 'offscreen',
        at: Date.now()
      });
    },    /** 被 service worker 判定为僵尸时，自己安静退出，让位给新建的连接桥 */
    shutdown: function () {
      wanted = false;
      try {
        if (socket) socket.close(1000, 'replaced');
      } catch (e) {
        /* ignore */
      }
      // 先把响应发回去，再关自己，否则 service worker 收不到应答
      setTimeout(function () {
        try {
          window.close();
        } catch (e) {
          /* ignore */
        }
      }, 30);
      return Promise.resolve({ closing: true });
    },
    ping: function () {
      return Promise.resolve({
        status: state.status,
        nonce: self.__r1Nonce || '',
        health: Object.assign({}, health, { nonce: self.__r1Nonce || '' }),
        at: Date.now()
      });
    }
  };

  runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'offscreen' || typeof msg.type !== 'string') return false;
    health.handled += 1;
    health.lastHandled = msg.type;
    health.lastHandledAt = Date.now();
    var handler = HANDLERS[msg.type];
    if (!handler) {
      sendResponse({ ok: false, error: '连接桥不支持该指令: ' + msg.type });
      return false;
    }
    Promise.resolve()
      .then(function () {
        return handler(msg);
      })
      .then(function (result) {
        sendResponse({ ok: true, result: result });
      })
      .catch(function (err) {
        // 记下来，随状态广播给 service worker，界面上就能看到连接桥内部到底出了什么错
        health.lastThrow = msg.type + ': ' + ((err && err.message) || String(err));
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
    return true; // 异步响应
  });

  /* ------------------------------------------------------------------ 启动 */

  if (storage && storage.onChanged) {
    storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      var next = Object.assign({}, C.DEFAULT_SETTINGS, changes.settings.newValue || {});
      var oldIp = C.hostOf(settings.ip);
      settings = next;
      var newIp = C.hostOf(settings.ip);
      if (newIp && newIp !== oldIp) {
        configure(newIp, wanted || newIp !== '');
      } else if (!newIp) {
        disconnect('未设置音箱地址');
      }
    });
  }

  // 文档被弃用时主动放开连接，避免孤儿文档还占着音箱的那条 WebSocket
  // （重复加载同一脚本时只注册一次）
  if (!self.__r1UnloadHook) {
    self.__r1UnloadHook = true;
    try {
      self.addEventListener('beforeunload', function () {
        try {
          if (socket) socket.close(1000, 'offscreen closing');
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* 某些环境没有 addEventListener，忽略即可 */
    }
  }

  /** 读取设置：优先用 chrome.storage；这个 API 不可用时改向 service worker 要 */
  function readSettings() {
    if (storage && storage.local && typeof storage.local.get === 'function') {
      return storage.local.get(C.SETTINGS_KEY).then(function (got) {
        return (got && got[C.SETTINGS_KEY]) || null;
      });
    }
    report('chrome.storage 不可用，改向 service worker 取设置');
    health.lastSent = 'settings:get';
    health.lastSentAt = Date.now();
    // 必须带超时：否则一旦这条消息没有回音，启动流程会永远停在这里
    // （界面表现为「连接状态 connecting、WebSocket 建立 0 次」，什么都等不到）
    return withTimeout(
      runtime
        .sendMessage({ target: 'background', type: 'settings:get' })
        .then(function (res) {
          return (res && res.ok && res.result && res.result.settings) || null;
        })
        .catch(function (err) {
          report('向后台取设置失败', (err && err.message) || '');
          return null;
        }),
      4000,
      '向后台取设置超时'
    ).catch(function (err) {
      report('向后台取设置超时', (err && err.message) || '');
      return null;
    });
  }

  readSettings()
    .then(function (saved) {
      settings = Object.assign({}, C.DEFAULT_SETTINGS, saved || {});
      var host = C.hostOf(settings.ip);
      report('设置读取完成', { ip: host || '(空)', source: saved ? '已拿到' : '未拿到' });
      if (host) {
        state.device.host = host;
        // 关键：连接桥自己就要把「保持连接」打开。
        // 之前这里漏了 wanted = true，导致开机自启实际依赖 service worker 主动来戳一下，
        // 一旦 service worker 只是 ping（不触发 configure），音箱就永远连不上。
        wanted = true;
        report('开始连接音箱', { url: C.wsUrl(host) });
        connect();
        scheduleReconnect();
      } else {
        report('设置里没有 IP，保持 disabled');
        status('disabled');
      }
    })
    .catch(function (err) {
      report('读取设置失败，使用默认值', (err && err.message) || '');
      status('disabled');
    });
})();
