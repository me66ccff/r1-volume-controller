/**
 * 测试脚手架：用假的 chrome.* API 把「真实的 service worker + 真实的屏幕外文档」跑起来。
 *
 * 为什么需要它：很多故障只在「两个上下文互相发消息」时才出现
 * （例如扩展重载后遗留的僵尸屏幕外文档），单独测一个文件是测不出来的。
 *
 * 提供：
 *   createHarness({ device })           建一套沙箱
 *   harness.loadWorker({install,startup}) 加载真实的 service-worker.js
 *   harness.loadOffscreen({orphan})     新建屏幕外文档（orphan=上下文已失效的僵尸）
 *   harness.sendToWorker(msg)           模拟弹窗给 service worker 发消息并等回包
 *   harness.reloadExtension()           模拟扩展重载：旧文档变僵尸，新 worker 启动
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONSTANTS = path.join(ROOT, 'src', 'common', 'constants.js');
const OFFSCREEN = path.join(ROOT, 'src', 'offscreen', 'offscreen.js');
const WORKER = path.join(ROOT, 'src', 'background', 'service-worker.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(p, 'utf8');

/* ------------------------------------------------------------------ 事件对象 */

function makeEvent(kind) {
  const listeners = [];
  return {
    kind,
    listeners,
    addListener(fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener(fn) {
      return listeners.indexOf(fn) >= 0;
    },
    emit(...args) {
      let result;
      listeners.forEach((fn) => {
        try {
          const r = fn(...args);
          if (r !== undefined) result = r;
        } catch (e) {
          /* 真实环境里监听器抛错只是打印，不阻断其它监听器 */
        }
      });
      return result;
    }
  };
}

/* ------------------------------------------------------------------ 假音箱 */

class FakeDevice {
  constructor(options) {
    const o = options || {};
    this.vol = typeof o.vol === 'number' ? o.vol : 5;
    this.max = o.max || 15;
    this.clampMinTo = o.clampMinTo || 0;
    this.swallowFirstZero = !!o.swallowFirstZero;
    this.includeMusicInfo = !!o.includeMusicInfo;
    this.zeroAttempts = 0;
    this.hostname = o.hostname || 'R1-TEST';
    this.sockets = [];
  }

  makeWebSocketClass() {
    const device = this;
    return class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        device.sockets.push(this);
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          if (this.onopen) this.onopen({});
        }, 0);
      }

      send(raw) {
        if (this.readyState !== 1) throw new Error('socket not open');
        const msg = JSON.parse(raw);
        const reply = (payload) => {
          setTimeout(() => {
            if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
          }, 0);
        };

        if (msg.type === 'get_info') {
          const info = {
            vol: device.vol,
            hostname: device.hostname,
            ip: '192.168.1.12',
            ver: '1.8.81',
            play_state: 0,
            play_mode: 2
          };
          if (device.includeMusicInfo) {
            info.music_info = { title: '测试曲目', arist: '测试歌手', duration: 1000 };
          }
          reply({ type: 'get_info', code: 1, data: JSON.stringify(info) });
          return;
        }

        if (msg.type === 'max_vol') {
          reply({ type: 'max_vol', code: 200, data: device.max });
          return;
        }

        if (msg.type === 'set_vol') {
          const want = Number(msg.vol);
          if (want === 0) {
            device.zeroAttempts += 1;
            if (device.swallowFirstZero && device.zeroAttempts === 1) return;
          }
          let next = Math.max(0, Math.min(device.max, want));
          if (device.clampMinTo > 0) next = Math.max(device.clampMinTo, next);
          device.vol = next;
        }
      }

      close() {
        this.readyState = 3;
      }
    };
  }

  get openSockets() {
    return this.sockets.filter((s) => s.readyState === 1);
  }
}

/* ------------------------------------------------------------------ 脚手架 */

function createHarness(options) {
  const o = options || {};
  const device = o.device instanceof FakeDevice ? o.device : new FakeDevice(o.device || {});

  const storageData = Object.assign({ settings: { ip: '192.168.1.12', step: 1 } }, o.storage || {});
  const storageChanged = makeEvent('storage.onChanged');

  const contexts = []; // { id, kind, messageEvent, sandbox, nonce, closed }
  let seq = 0;
  const sendLog = [];

  const panelWindows = [];
  const panelTabs = [];
  let lastCreateOptions = null;
  let worker = null;

  function helloReply(context, msg) {
    if (context.scriptless) {
      // 脚本没跑起来的文档：不会登记 nonce，握手指纹永远对不上
      return { ok: true, result: { nonce: '', origin: 'offscreen', at: Date.now() } };
    }
    if (context.nonce === null) return null;
    if (msg.nonce) context.nonce = String(msg.nonce);
    return { ok: true, result: { nonce: context.nonce, origin: context.kind, at: Date.now() } };
  }

  /** 模拟 chrome.runtime.sendMessage：投给除发送者外的所有监听器，谁先应答谁生效 */
  function dispatch(senderId, message, callback) {
    const msg = message && typeof message === 'object' ? message : {};
    sendLog.push({ from: senderId, type: msg.type || '?', target: msg.target || '' });

    let settled = false;
    let willRespondAsync = false; // 有监听器返回 true，表示它会异步应答
    const others = contexts.filter((c) => c.id !== senderId && !c.dead);
    sendLog.push({
      from: senderId,
      type: msg.type || '?',
      candidates: others.map((c) => c.kind + ':' + c.id + ':' + c.messageEvent.listeners.length).join(',')
    });

    function reply(value, note) {
      if (settled) return;
      settled = true;
      sendLog.push({ from: senderId, type: msg.type || '?', note: note || 'callback', value: value === undefined ? 'undefined' : 'value' });
      if (callback) callback(value);
    }

    for (const ctx of others) {
      if (settled) break;
      // 握手消息：脚本没跑起来的文档由总线代答（这样握手指纹永远对不上，能被识破）；
      // legacy 文档表示「更早版本创建的连接桥」：它功能完好但不认识握手协议，
      // 总线也不替它代答，于是握手指纹永远匹配不上 —— 后台必须照常采纳它的状态。
      // 健康文档则交给它自己的监听器应答 —— 它需要真正收到 nonce 才知道自己属于哪个会话。
      const isHello = ctx.kind === 'offscreen' && (msg.type === 'hello' || msg.type === 'ping');
      const delegate = !isHello || (!ctx.scriptless && !ctx.legacy);
      if (delegate) {
        for (const fn of ctx.messageEvent.listeners) {
          if (settled) break;
          sendLog.push({ from: senderId, type: msg.type || '?', note: 'invoking:' + ctx.id });
          let returned;
          try {
            returned = fn(msg, { id: 'fake-sender' }, (response) => {
              if (isHello && response && response.result && typeof response.result.nonce === 'string') {
                ctx.nonce = response.result.nonce; // 文档已登记会话标识
              }
              reply(response, 'listener:' + ctx.id);
            });
          } catch (e) {
            sendLog.push({
              from: senderId,
              type: msg.type || '?',
              note: 'listener-threw:' + ctx.id,
              error: String((e && e.stack) || e).slice(0, 400)
            });
          }
          sendLog.push({
            from: senderId,
            type: msg.type || '?',
            note: 'returned:' + ctx.id,
            value: String(returned)
          });
          // 与 Chrome 一致：返回 true 表示「我会异步应答」，此时不能判定无人响应
          if (returned === true) willRespondAsync = true;
        }
      } else if (!willRespondAsync) {
        // legacy：总线也不代答，让握手指纹永远对不上（这正是旧版连接桥的样子）
        if (!ctx.legacy) {
          const hello = helloReply(ctx, msg);
          if (hello) setTimeout(() => reply(hello, 'bus-hello:' + ctx.id), 0);
        }
      }
    }

    // 只有当确实没有监听器愿意应答时，才回复「无接收方」；
    // 有监听器返回了 true 就必须一直等它的 sendResponse（否则长耗时操作会被误判为失败）
    if (!settled && !willRespondAsync) setTimeout(() => reply(undefined, 'no-listener'), 0);

    const promise = new Promise((resolve, reject) => {
      setTimeout(() => {
        if (!settled) reject(new Error('Could not establish connection. Receiving end does not exist.'));
      }, 8);
    });
    promise.catch(() => {});
    return promise;
  }

  function makeApi(context) {
    return {
      runtime: {
        id: 'fake-extension-id',
        lastError: undefined,
        onMessage: context.messageEvent,
        onInstalled: context.onInstalled,
        onStartup: context.onStartup,
        // 兼容两种写法：sendMessage(msg, cb) 和 await sendMessage(msg)
        sendMessage(msg, cb) {
          if (typeof cb === 'function') {
            return dispatch(context.id, msg, cb);
          }
          return new Promise((resolve, reject) => {
            dispatch(context.id, msg, (response) => {
              if (response === undefined) {
                reject(new Error('Could not establish connection. Receiving end does not exist.'));
                return;
              }
              resolve(response);
            });
          });
        },
        getURL: (p) => 'chrome-extension://fake-extension-id/' + String(p).replace(/^\//, ''),
        openOptionsPage: () => Promise.resolve()
      },
      storage: {
        local: {
          get(keys) {
            if (!keys) return Promise.resolve(Object.assign({}, storageData));
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            list.forEach((k) => {
              if (k in storageData) out[k] = storageData[k];
            });
            return Promise.resolve(out);
          },
          set(patch) {
            const changes = {};
            Object.keys(patch).forEach((k) => {
              changes[k] = { oldValue: storageData[k], newValue: patch[k] };
              storageData[k] = patch[k];
            });
            setTimeout(() => storageChanged.emit(changes, 'local'), 0);
            return Promise.resolve();
          },
          remove(key) {
            const keys = Array.isArray(key) ? key : [key];
            const changes = {};
            keys.forEach((k) => {
              changes[k] = { oldValue: storageData[k] };
              delete storageData[k];
            });
            setTimeout(() => storageChanged.emit(changes, 'local'), 0);
            return Promise.resolve();
          }
        },
        onChanged: storageChanged
      }
    };
  }

  function makeContext(kind) {
    const context = {
      id: 'ctx' + ++seq,
      kind,
      dead: false,
      nonce: null,
      messageEvent: makeEvent('runtime.onMessage'),
      onInstalled: makeEvent('onInstalled'),
      onStartup: makeEvent('onStartup'),
      sandbox: null
    };
    contexts.push(context);
    return context;
  }

  /** 建一个屏幕外文档；orphan=true 表示扩展重载后遗留、上下文已失效的僵尸 */
  function loadOffscreen(env) {
    const opts = env || {};
    const context = makeContext('offscreen');
    const api = makeApi(context);

    // scriptless：文档创建成功，但脚本没跑起来（比如一启动就自己退出了）
    if (opts.scriptless) {
      context.scriptless = true;
      context.nonce = null; // 脚本没跑，自然登记不了 nonce
      context.sandbox = { window: { close() {} }, self: {} };
      return context;
    }

    // noStorage：实测某些 Chrome 版本的屏幕外文档里 chrome.storage 就是 undefined。
    // 连接桥必须能降级（改向 service worker 要设置），而不是判自己死刑。
    if (opts.noStorage) {
      delete api.storage;
      context.noStorage = true;
    }
    // 正常文档由总线代答握手，并把收到的 nonce 记下来
    context.nonce = '__awaiting-nonce__';
    if (opts.orphan) {
      // 僵尸：上下文已失效（拿不到 runtime.id），握手永不成功，也自己关闭不了
      delete api.runtime.id;
      context.nonce = null;
      context.zombie = true;
      context.sandbox = null;
    }

    const sandbox = {
      console: opts.noisy ? console : { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      Number,
      String,
      Object,
      Array,
      JSON,
      Promise,
      isFinite,
      WebSocket: device.makeWebSocketClass(),
      chrome: api
    };
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.window.close = () => {
      // 真实环境里，上下文已失效的文档连 window.close() 都关不掉自己
      if (context.zombie) return;
      context.dead = true;
    };

    vm.createContext(sandbox);
    vm.runInContext(read(CONSTANTS), sandbox, { filename: CONSTANTS });
    vm.runInContext(read(OFFSCREEN), sandbox, { filename: OFFSCREEN });

    // 僵尸文档在 Chrome 里会从 getContexts() 里消失（已经是上一个扩展版本的对象）
    if (context.zombie) context.dead = true;

    context.sandbox = sandbox;
    return context;
  }

  /** 仍然被 getContexts() 认作「存在」的文档（僵尸不算） */
  function aliveDocs() {
    return contexts.filter((c) => c.kind === 'offscreen' && !c.dead && !c.zombie);
  }

  /** 确实创建过的文档数量，用来判断有没有重建 */
  function allDocs() {
    return contexts.filter((c) => c.kind === 'offscreen');
  }

  function loadWorker(env) {
    const opts = env || {};
    const context = makeContext('worker');
    const api = makeApi(context);

    // offscreen 选项只作用于「第一个被创建的文档」。
    // 否则后面每次重建都会再次带上故障注入，永远恢复不了 —— 那就不叫故障注入了。
    let firstCreate = true;

    api.offscreen = {
      createDocument(docOptions) {
        if (aliveDocs().length > 0) {
          return Promise.reject(new Error('Only a single offscreen document may be created.'));
        }
        lastCreateOptions = docOptions;
        loadOffscreen(firstCreate ? opts.offscreen || {} : {});
        firstCreate = false;
        return Promise.resolve();
      }
    };

    // 同时支持两类查询：
    //   OFFSCREEN_DOCUMENT -> 连接桥是否存在
    //   TAB                -> 面板是否已经打开（没有 tabs 权限时用它替代 tab.url）
    api.runtime.getContexts = (filter) => {
      const types = (filter && filter.contextTypes) || [];
      const urls = (filter && filter.documentUrls) || [];

      if (types.indexOf('TAB') >= 0) {
        const hit = panelTabs.filter((t) => !urls.length || urls.some((u) => t.url === u));
        return Promise.resolve(
          hit.map((t) => ({ contextType: 'TAB', tabId: t.id, windowId: t.windowId, documentUrl: t.url }))
        );
      }

      const alive = aliveDocs().some((d) => !urls.length || urls.some((u) => u.indexOf('offscreen') >= 0));
      return Promise.resolve(alive ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []);
    };

    api.alarms = {
      clear: () => Promise.resolve(true),
      create: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      onAlarm: makeEvent('onAlarm')
    };

    api.action = {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setTitle() {},
      openPopup: () => Promise.resolve()
    };

    api.commands = {
      onCommand: makeEvent('commands.onCommand')
    };

    api.windows = {
      getAll: (info) => {
        const kind = info && info.windowTypes && info.windowTypes[0];
        if (kind === 'popup') return Promise.resolve(panelWindows.map((id) => ({ id, type: 'popup' })));
        return Promise.resolve([]);
      },
      create: (createOptions) => {
        const id = 900 + panelWindows.length;
        panelWindows.push(id);
        panelTabs.push({ id: 1000 + panelTabs.length, windowId: id, url: createOptions.url });
        return Promise.resolve({ id });
      },
      update: (id) => Promise.resolve({ id }),
      remove: (id) => {
        const i = panelWindows.indexOf(id);
        if (i < 0) return Promise.reject(new Error('No window with id: ' + id));
        panelWindows.splice(i, 1);
        return Promise.resolve();
      },
      onRemoved: makeEvent('windows.onRemoved')
    };

    api.tabs = {
      query: (query) => {
        if (query && query.url) return Promise.resolve(panelTabs.filter((t) => t.url === query.url));
        return Promise.resolve(panelTabs.slice());
      },
      create: (createOptions) => {
        const tab = { id: 1000 + panelTabs.length, windowId: 1, url: createOptions.url };
        panelTabs.push(tab);
        return Promise.resolve(tab);
      },
      update: (id) => Promise.resolve({ id }),
      remove: (id) => {
        const i = panelTabs.findIndex((t) => t.id === id);
        if (i >= 0) panelTabs.splice(i, 1);
        return Promise.resolve();
      },
      sendMessage: () => Promise.resolve(),
      onRemoved: makeEvent('tabs.onRemoved')
    };

    const sandbox = {
      console: o.noisyWorker ? console : { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      Number,
      String,
      Object,
      Array,
      JSON,
      Promise,
      isFinite,
      WebSocket: device.makeWebSocketClass(),
      chrome: api,
      importScripts(rel) {
        const file = path.resolve(path.dirname(WORKER), rel);
        vm.runInContext(read(file), sandbox, { filename: file });
      }
    };
    sandbox.self = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(read(WORKER), sandbox, { filename: WORKER });

    context.sandbox = sandbox;
    context.api = api;
    worker = context;
    return context;
  }

  /** 模拟弹窗：给 service worker 发消息并等回包 */
  function sendToWorker(message, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ __timeout: true });
      }, timeoutMs || 8000);
      dispatch('ui-client', message, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  return {
    device,
    contexts,
    storage: storageData,
    sendLog,
    loadOffscreen,
    loadWorker,
    sendToWorker,
    aliveDocs,
    allDocs,
    get worker() {
      return worker;
    },
    get lastCreateOptions() {
      return lastCreateOptions;
    },
    get panelWindows() {
      return panelWindows;
    },
    get panelTabs() {
      return panelTabs;
    },
    killAllOffscreen() {
      aliveDocs().forEach((d) => {
        d.dead = true;
      });
    },
    /** 模拟扩展重载：旧版本文档全部失效；opts.orphan 表示浏览器里还留着一个收不到消息的僵尸 */
    reloadExtension(opts) {
      const options = opts || {};
      // 旧版本创建的文档，其 JS 上下文随扩展重载一起失效
      contexts
        .filter((c) => c.kind === 'offscreen' && !c.dead)
        .forEach((c) => {
          c.dead = true;
          c.zombie = true;
        });
      if (options.orphan) loadOffscreen({ orphan: true });
      if (options.markOldWorkerDead !== false && worker) worker.dead = true;
      return loadWorker();
    }
  };
}

module.exports = { createHarness, FakeDevice, makeEvent, sleep, ROOT, CONSTANTS, OFFSCREEN, WORKER };
