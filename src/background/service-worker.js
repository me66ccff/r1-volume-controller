/**
 * Service Worker：全局唯一的状态中枢。
 *
 * 职责：
 *  1. 保证屏幕外文档（offscreen document）唯一存在 —— 那是全局唯一的一条设备连接；
 *  2. 所有 UI（弹窗 / 悬浮面板 / 设置页）都必须通过这里下发指令，
 *     因此永远不会出现两个界面互相打架的情况；
 *  3. 开机自启、定时保活、把状态同步给所有已打开的界面；
 *  4. 图标角标实时显示音量，键盘快捷键直接调音。
 */
importScripts('../common/constants.js');

var C = self.R1;
var OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

var settings = Object.assign({}, C.DEFAULT_SETTINGS);
var latest = { status: 'disabled', device: C.emptyDevice(), lastError: '', syncing: false, updatedAt: 0 };

/**
 * 设置读取完成的信号。
 * service worker 冷启动时设置是异步读出来的，但消息监听器是同步就绪的；
 * 如果这时界面来问状态，就会拿着空设置回答「未配置音箱」，
 * 而且之后不会自愈（界面不会主动再问第二次）。所以所有界面消息先等这个 Promise。
 */
var settingsReady = loadSettings();
// 这个 Promise 永远不该以拒绝收场，否则所有界面请求都会卡在 await 上
settingsReady.catch(function (err) {
  recordError('读取设置', err);
  settings = Object.assign({}, C.DEFAULT_SETTINGS);
});
var wakePromise = null;

var offscreenPromise = null;
var offscreenAlive = false; // 只表示「连接桥文档是否存在」，不是 API 是否存在
var lastKnownVol = null;
var lastBootError = ''; // 连接桥建不起来时记下原因，方便界面提示

/**
 * 诊断信息：把「后台到底卡在哪一步」变成界面能显示的东西。
 * 用户截图就能定位，不用去翻 chrome://extensions 的错误面板。
 */
var diag = {
  bootedAt: Date.now(),
  wakes: 0,
  lastRequest: '',
  lastRequestAt: 0,
  lastReplyAt: 0,
  lastError: '',
  replies: 0,
  offscreenHealth: null,
  bridgeStage: '未开始',
  offscreenBoot: null,
  documentCount: null
};

function recordError(where, err) {
  diag.lastError = where + ': ' + ((err && err.message) || String(err));
}


/**
 * 本次 service worker 实例的随机标识。
 * 扩展重新加载后，旧版本创建的屏幕外文档可能变成「僵尸」：文档还在（getContexts 能查到），
 * 但它的扩展上下文已经失效，既读不到设置也不会响应指令。
 * 这时如果只判断「文档是否存在」就会永远不重建，界面表现为一直连不上。
 * 所以每次启动都用一个新的 nonce 握手：对不上的一律当作不可用并强制重建。
 */
var BRIDGE_NONCE = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);

/**
 * 会话校验：连接桥广播状态时必须带上「它属于哪个 service worker 会话」。
 * 但标识由连接桥自己生成 —— 不能要求它必须等于本实例的 nonce：
 * 一个更早版本创建、不认识 hello 握手的连接桥是**完全可用**的，
 * 强行要求它会把这些正常状态全部丢掉（实测到过）。
 *
 * 所以规则是「谁先证明自己是活的，就认谁」：第一次收到带 token 的广播时收下它，
 * 之后换 token（例如连接桥被重建）就跟着更新。
 */
var BRIDGE_TOKEN = null;

/**
 * 状态来源必须校验。
 * 扩展重载后，上一个 worker 实例留下的屏幕外文档可能还活着并继续广播状态，
 * 但它不响应新 worker 的任何指令 —— 于是界面看到「已连接」，实际操作却全部失败。
 */
function applyOffscreenState(next, health, session) {
  if (!next || typeof next !== 'object') return;
  if (session) {
    if (BRIDGE_TOKEN === null) {
      BRIDGE_TOKEN = session; // 第一个能上报状态的连接桥就是当前会话的桥
    } else if (session !== BRIDGE_TOKEN) {
      // 换了新桥（旧桥被替换/重建），跟着更新
      BRIDGE_TOKEN = session;
    }
  }
  latest = Object.assign({}, latest, {
    status: next.status || 'offline',
    device: Object.assign(C.emptyDevice(), next.device || {}),
    lastError: next.lastError || '',
    syncing: !!next.syncing,
    updatedAt: next.updatedAt || Date.now()
  });
  if (health) diag.offscreenHealth = health;
  updateBadge();
  persistState();
  broadcast();
}

/* ------------------------------------------------------------------ 屏幕外文档 */

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    var contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return contexts.length > 0;
  } catch (e) {
    return false;
  }
}

function ensureOffscreen() {
  // 注意：经典 service worker 里没有顶层 await，这里必须用 Promise 链
  if (offscreenPromise) return offscreenPromise;
  var work = hasOffscreen()
    .then(function (exists) {
      if (!exists) {
        // 文档已经不在了：之前记的「桥可用」立刻作废
        offscreenAlive = false;
        return createBridge();
      }
      // 文档还在，但要确认它真的回话（可能是僵尸或脚本没跑起来）
      return verifyBridge();
    });
  // 双保险：万一内部某一步没结束，也不能把这个单例 Promise 永久挂住，
  // 否则后面所有唤醒都会复用它，重建逻辑再也没机会跑。
  offscreenPromise = withTimeout(work, 9000, '连接桥操作超时').then(
    function (v) {
      if (offscreenPromise === outer) offscreenPromise = null;
      return v;
    },
    function (err) {
      if (offscreenPromise === outer) offscreenPromise = null;
      throw err;
    }
  );
  var outer = offscreenPromise;
  return outer;
}

/**
 * 只负责「把文档建出来」，不做任何重试决策。
 * 重试与替换统一由 confirmBridge 负责，避免两层重试互相打架
 * （之前就是两层重试套在一起，导致「发现桥不回话后重建」这一步根本没执行）。
 */
function createBridge() {
  if (!chrome.offscreen) {
    return Promise.reject(new Error('当前浏览器内核不支持 offscreen API，请升级到 Chrome/Edge 116 以上'));
  }
    diag.bridgeStage = '创建屏幕外文档…';
  return chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: '在后台长期保持与 R1 音箱的 WebSocket 连接，浏览器关闭前不中断。'
    })
    .then(function () {
      // 创建成功后给文档 200ms，让它有机会自报家门；报不上来基本就是没跑起来
      return wait(200).then(function () {
        diag.bridgeStage = diag.offscreenBoot
          ? '文档已创建，自报: ' + diag.offscreenBoot.line
          : '文档已创建，但从未自报（脚本没跑起来？），正在握手确认…';
      });
    })
    .catch(function (err) {
      diag.bridgeStage = '创建失败: ' + ((err && err.message) || String(err));
      throw err;
    });
}

/** 握手确认桥真的活着；不行就让它让位重建，最终仍失败则明确报错 */
function confirmBridge(attempt) {
  // 关键：新建的文档需要时间加载脚本并注册消息监听器。
  // 只发一次 hello 很容易在「文档刚创建、脚本还没就绪」时落空，
  // 于是被误判成「创建后没有响应」，接着永远建不起来。
  return helloUntilAlive(0)
    .then(function () {
      offscreenAlive = true;
      lastBootError = '';
      return true;
    })
    .catch(function (err) {
      offscreenAlive = false;
      var msg = (err && err.message) || String(err);
      if (/single offscreen/i.test(msg)) {
        lastBootError = '旧的连接桥无法回收（Chrome 同时只允许一个）：' + msg;
      } else {
        lastBootError = '连接桥没有响应：' + msg;
      }
      if (attempt >= 2) {
        throw new Error(lastBootError);
      }
      // 让位给新的文档（能收到消息的会自己关闭），然后重来一次
      return chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'shutdown' })
        .catch(function () {
          return null;
        })
        .then(function () {
          return wait(300);
        })
        .then(function () {
          return createBridge();
        })
        .then(function () {
          return confirmBridge(attempt + 1);
        });
    });
}

/** 在 5 秒内反复握手，直到桥确认自己是本实例的 */
function helloUntilAlive(elapsed) {
  return chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'hello', nonce: BRIDGE_NONCE })
    .then(function (res) {
      if (res && res.ok && res.result) {
        // 认下它自己上报的会话标识；旧版本连接桥靠这个也能被正常采纳
        if (res.result.token) BRIDGE_TOKEN = res.result.token;
        if (res.result.nonce === BRIDGE_NONCE) return true;
        throw new Error('握手回包 nonce 不匹配');
      }
      throw new Error('握手没有回包');
    })
    .catch(function (err) {
      if (elapsed >= 5000) {
        throw new Error(((err && err.message) || String(err)) + '（等待 5 秒仍无有效应答）');
      }
      return wait(200).then(function () {
        return helloUntilAlive(elapsed + 200);
      });
    });
}

/** 用 nonce 握手，确认现有屏幕外文档确实是本次实例的 */
function verifyBridge() {
  return withTimeout(
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'hello', nonce: BRIDGE_NONCE }),
    1500,
    '连接桥握手超时'
  )
    .then(function (res) {
      if (res && res.ok && res.result && res.result.nonce === BRIDGE_NONCE) {
        offscreenAlive = true;
        return null;
      }
      return replaceZombie();
    })
    .catch(function () {
      return replaceZombie();
    });
}

/** 现有文档无法确认是本实例的（僵尸），请它退出，等它真的消失后再重建 */
function replaceZombie() {
  offscreenAlive = false;
  lastBootError = '旧的连接桥没有响应，正在重建';
  return chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'shutdown' })
    .catch(function () {
      return null;
    })
    .then(function () {
      return withTimeout(waitGone(0), 2500, '回收旧连接桥超时').catch(function () {
        // 回收不掉时不要把整条链拖死：交给下一次唤醒再试
        throw new Error('旧的连接桥无法回收，请点一次「重新加载」');
      });
    });
}

/** 等屏幕外文档彻底消失（最多约 2.5 秒），然后新建一个 */
function waitGone(elapsed) {
  return hasOffscreen().then(function (exists) {
    if (!exists) {
      offscreenAlive = false;
      return chrome.offscreen
        .createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['WORKERS'],
          justification: '在后台长期保持与 R1 音箱的 WebSocket 连接，浏览器关闭前不中断。'
        })
        .then(function () {
          offscreenAlive = true;
        });
    }
    if (elapsed > 2500) {
      // 旧文档死活不肯走：此时无法创建新文档，明确报错让界面给出可操作提示
      throw new Error('旧的连接桥无法回收，请在扩展页点一次「重新加载」');
    }
    return wait(200).then(function () {
      // 再推它一把：上下文已失效的文档收不到消息，活着的会自己关闭
      return chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'shutdown' })
        .catch(function () {
          return null;
        })
        .then(function () {
          return waitGone(elapsed + 200);
        });
    });
  });
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function receiverGone(err) {
  var msg = String((err && err.message) || err);
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(msg);
}

/** 把底层报错翻译成用户能照着做的中文提示 */
function friendlyError(err) {
  var msg = String((err && err.message) || err || '操作失败');
  if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(msg)) {
    return '连接桥没有响应（后台已尝试重连）';
  }
  if (/超时/.test(msg)) return msg;
  return msg;
}

/** 给任何 Promise 加超时，避免界面请求永远得不到回应（那会表现为「连接桥无响应」） */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise(function (resolve, reject) {
      setTimeout(function () {
        reject(new Error(message || '操作超时'));
      }, ms);
    })
  ]);
}

/**
 * 强制重建连接桥：清掉所有缓存的 Promise 与定时器，从头再来一遍。
 * 界面上有「重建连接桥」按钮 —— 当自动重试恰好卡在某个缓存状态里时，
 * 这是让用户立刻恢复的确定性手段（比让用户去点「重新加载」友好得多）。
 */
function resetBridge() {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  wakeRetries = 0;
  wakePromise = null;
  offscreenPromise = null;
  offscreenAlive = false;
  lastBootError = '';
  diag.bridgeStage = 'reset:开始';
  return chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'shutdown' })
    .catch(function () {
      return null;
    })
    .then(function () {
      diag.bridgeStage = 'reset:已请求旧桥退出';
      return wait(200);
    })
    .then(function () {
      diag.bridgeStage = 'reset:正在重建';
      return ensureOffscreen();
    })
    .then(function () {
      // ensureOffscreen 可能「成功返回但桥其实不可用」，必须自己断言，
      // 否则错误原因会被丢掉，界面只能显示一个空字符串（真踩过）
      if (!offscreenAlive) {
        throw new Error(lastBootError || diag.bridgeStage || '连接桥重建后仍不可用');
      }
      diag.bridgeStage = 'reset:完成';
      return { rebuilt: true, bridge: true, error: '' };
    })
    .catch(function (err) {
      lastBootError = (err && err.message) || String(err) || '未知原因';
      diag.bridgeStage = 'reset:失败 - ' + lastBootError;
      return { rebuilt: false, bridge: false, error: lastBootError };
    });
}

/** 统一通过屏幕外文档执行设备指令 */
async function call(type, payload, attempt) {
  var tries = attempt || 0;
  await ensureOffscreen();
  try {
    var res = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen', type: type }, payload || {}));
    if (!res || typeof res !== 'object') throw new Error('连接桥无响应');
    if (!res.ok) throw new Error(res.error || '指令失败');
    return res.result;
  } catch (err) {
    if (tries < 2 && receiverGone(err)) {
      await new Promise(function (r) {
        setTimeout(r, 220);
      });
      return call(type, payload, tries + 1);
    }
    throw err;
  }
}

function callQuiet(type, payload) {
  return call(type, payload).catch(function (err) {
    return { __error: (err && err.message) || String(err) };
  });
}

/**
 * 唤醒/校验连接桥，并记住结果。
 * 界面每次问状态都会走一遍：hello 握手很快，但能在弹窗打开的那一刻
 * 发现僵尸文档并重建，避免出现「怎么点都连不上」。
 *
 * 两条必须遵守的规则（都是真踩过的坑）：
 *  1. 这个 Promise 必须保证会结束，否则之后每次请求都复用它，重建逻辑永远没机会再跑；
 *  2. 一次失败不能就此收手 —— 必须自己安排下一次尝试，否则界面会永远停在「连不上」。
 */
function wakeBridge() {
  if (wakePromise) return wakePromise;
  var chain = withTimeout(ensureOffscreen(), 4000, '唤醒连接桥超时').catch(function (err) {
    lastBootError = (err && err.message) || String(err);
    offscreenAlive = false;
    return null;
  });
  wakePromise = chain;
  chain.then(function () {
    if (wakePromise === chain) wakePromise = null;
    if (offscreenAlive) {
      wakeRetries = 0;
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
      return;
    }
    // 桥还不可用就自己再试 —— 不要依赖界面再问一次
    scheduleWake(2000);
  });
  return chain;
}

var wakeTimer = null;
var wakeRetries = 0;

/** 修不好就自己再来一次：最多连续 3 次，避免无限重试 */
function scheduleWake(delay) {
  if (wakeTimer || wakeRetries >= 3) return;
  wakeRetries += 1;
  wakeTimer = setTimeout(function () {
    wakeTimer = null;
    wakeBridge();
  }, delay);
}

/* ------------------------------------------------------------------ 存储 */

async function loadSettings() {
  try {
    var got = await chrome.storage.local.get(C.SETTINGS_KEY);
    settings = Object.assign({}, C.DEFAULT_SETTINGS, (got && got[C.SETTINGS_KEY]) || {});
  } catch (e) {
    settings = Object.assign({}, C.DEFAULT_SETTINGS);
  }
  return settings;
}

async function patchSettings(patch) {
  settings = Object.assign({}, settings, patch || {});
  await chrome.storage.local.set({ [C.SETTINGS_KEY]: settings });
  updateBadge();
  return settings;
}

async function persistState() {
  try {
    await chrome.storage.local.set({
      [C.STATE_KEY]: {
        status: latest.status,
        vol: latest.device ? latest.device.vol : null,
        max: latest.device ? latest.device.max : null,
        host: latest.device ? latest.device.host : '',
        hostname: latest.device ? latest.device.hostname : '',
        at: Date.now()
      }
    });
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ 状态 & 角标 */

function isOnline() {
  return latest.status === 'online';
}

function updateBadge() {
  var text = '';
  var color = '#5b6472';
  if (!settings.ip) {
    text = '!';
    color = '#8a94a6';
  } else if (isOnline()) {
    text = String(latest.device.vol);
    color = latest.device.vol === 0 ? '#8a94a6' : '#ff5f56';
  } else if (latest.status === 'connecting' || latest.syncing) {
    text = '…';
    color = '#e0a04a';
  } else {
    text = '!';
    color = '#7c889c';
  }
  try {
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color });
    chrome.action.setTitle({
      title: settings.ip
        ? 'R1 音箱 ' + (latest.device.hostname || latest.device.host || settings.ip) + '：' + (isOnline() ? '音量 ' + latest.device.vol + '/' + latest.device.max : '未连接')
        : 'R1 音箱音量控制器（尚未设置 IP）'
    });
  } catch (e) {
    /* ignore */
  }
}

function publicState() {
  return {
    status: latest.status,
    device: latest.device,
    lastError: latest.lastError || lastBootError,
    syncing: !!latest.syncing,
    ip: settings.ip,
    settings: settings,
    bridge: offscreenAlive,
    updatedAt: latest.updatedAt
  };
}

async function broadcast() {
  var state = publicState();
  // 扩展页面（弹窗 / 悬浮面板 / 设置页）
  await chrome.runtime.sendMessage({ target: 'ui', type: 'state', state: state }).catch(function () {});
}

/* ------------------------------------------------------------------ 面板窗口（全局唯一） */

var panelWindowId = null;
var panelTabId = null;
var PANEL_PATH = 'src/panel/panel.html';

function isPanelUrl(url) {
  return typeof url === 'string' && url.split('#')[0].split('?')[0].endsWith(PANEL_PATH);
}

/**
 * 查找已经打开的面板窗口，找到就聚焦。
 *
 * 这里刻意不用 tab.url 判断 —— 收窄权限后没有 tabs 权限，tab.url 会是 undefined。
 * 改用 runtime.getContexts()：它能列出我们扩展自己的页面，不需要任何权限，
 * 也不受 URL 读取限制影响。
 */
async function focusExistingPanel() {
  try {
    if (!chrome.runtime.getContexts) return false;
    var ctxs = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [chrome.runtime.getURL(PANEL_PATH)]
    });
    if (!ctxs.length) return false;

    var wins = await chrome.windows.getAll({ windowTypes: ['popup'] });
    var tabs = await chrome.tabs.query({});
    for (var i = 0; i < ctxs.length; i++) {
      var tabId = ctxs[i].tabId;
      if (tabId === undefined || tabId < 0) continue;
      var tab = tabs.filter(function (t) {
        return t.id === tabId;
      })[0];
      if (!tab) continue;
      var isPopup = wins.some(function (w) {
        return w.id === tab.windowId;
      });
      if (isPopup) {
        panelWindowId = tab.windowId;
        panelTabId = null;
        try {
          await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
        } catch (e) {
          /* ignore */
        }
        return true;
      }
      // 面板开在普通标签页里（极少见）：需要 tabs 权限才能把它切到前台，
      // 没有权限时就不强行操作，交给后面新建一个窗口
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

/** 关闭面板：service worker 重启后内存里的 id 会丢，所以这里要按 URL 兜底查找 */
async function closePanel() {
  if (panelWindowId !== null) {
    try {
      await chrome.windows.remove(panelWindowId);
      panelWindowId = null;
      panelTabId = null;
      return true;
    } catch (e) {
      panelWindowId = null;
    }
  }
  try {
    var tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(PANEL_PATH) });
    for (var i = 0; i < tabs.length; i++) {
      await chrome.tabs.remove(tabs[i].id);
    }
    panelTabId = null;
    return true;
  } catch (e) {
    /* ignore */
  }
  return false;
}

async function openPanel() {
  if (await focusExistingPanel()) return 'focused';
  var width = 400;
  var height = 640;
  try {
    var win = await chrome.windows.create({
      url: chrome.runtime.getURL(PANEL_PATH),
      type: 'popup',
      width: width,
      height: height,
      focused: true
    });
    panelWindowId = win.id;
    panelTabId = null;
    return 'opened';
  } catch (e) {
    /* 独立窗口开不出来（极少见），退化为标签页 */
  }
  try {
    var tab = await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
    panelTabId = tab && tab.id ? tab.id : null;
    panelWindowId = tab && tab.windowId !== undefined ? tab.windowId : null;
    return 'tab';
  } catch (e) {
    throw new Error('无法打开面板，请点击工具栏的扩展图标');
  }
}

/* ------------------------------------------------------------------ 指令路由 */

var LABELS = {
  vol_up: '音量 +',
  vol_down: '音量 -',
  mute_toggle: '静音切换',
  set_vol: '设置音量',
  set_mute: '静音'
};

function toastLabel(msg) {
  return msg.label || LABELS[msg.action] || msg.action || '操作';
}

async function runAction(msg) {
  var device = latest.device || C.emptyDevice();
  var step = C.clamp(msg.step || settings.step || 1, 1, 30);

  switch (msg.action) {
    case 'set_vol': {
      var target = C.clamp(msg.vol, 0, device.max);
      lastKnownVol = target;
      optimisticVolume(target);
      var r = await call('set_vol', { vol: target });
      return { ok: true, vol: r.vol, max: r.max, label: '音量 ' + target };
    }
    case 'bump': {
      var delta = Number(msg.delta) || 0;
      var base = device.vol;
      if (delta > 0 && base === 0 && lastKnownVol) base = Math.max(0, lastKnownVol - delta);
      var t = C.clamp(base + delta, 0, device.max);
      if (t === device.vol) return { ok: true, vol: device.vol, max: device.max, unchanged: true, label: '已到极限' };
      lastKnownVol = t;
      optimisticVolume(t);
      var rb = await call('set_vol', { vol: t });
      return { ok: true, vol: rb.vol, max: rb.max, label: '音量 ' + t };
    }
    case 'vol_up':
      return runAction({ action: 'bump', delta: step, label: '音量 +' + step });
    case 'vol_down':
      return runAction({ action: 'bump', delta: -step, label: '音量 -' + step });
    case 'set_mute': {
      var mute = msg.mute === undefined ? device.vol > (device.min || 0) : !!msg.mute;
      if (mute) lastKnownVol = device.vol || lastKnownVol;
      optimisticVolume(mute ? device.min || 0 : lastKnownVol || device.max);
      var rm = await call('set_mute', { mute: mute });
      return {
        ok: true,
        vol: rm.vol,
        max: rm.max,
        muted: rm.muted,
        downgraded: !!rm.downgraded,
        label: rm.label || (rm.muted ? '已静音' : '已恢复音量')
      };
    }
    case 'mute_toggle': {
      var floor = Number(device.min) || 0;
      var isMuted = Number(device.vol) <= floor;
      return runAction({ action: 'set_mute', mute: !isMuted });
    }
    case 'set_max':
      return call('set_max', { max: msg.max });
    case 'play':
      await call('play');
      return { ok: true, label: '播放' };
    case 'pause':
      await call('pause');
      return { ok: true, label: '暂停' };
    case 'next':
      await call('next');
      return { ok: true, label: '下一首' };
    case 'prev':
      await call('prev');
      return { ok: true, label: '上一首' };
    case 'reboot':
      await call('reboot');
      return { ok: true, label: '正在重启 EchoService' };
    case 'open_panel':
      return { ok: true, opened: await openPanel(), label: '正在打开面板' };
    case 'refresh': {
      var fresh = await call('refresh');
      return { ok: true, state: fresh, label: '已刷新' };
    }
    case 'connect':
      await patchSettings({ ip: C.hostOf(msg.ip || settings.ip) });
      await call('configure', { ip: settings.ip, auto: true });
      return { ok: true, label: '连接中…' };
    case 'disconnect':
      await call('disconnect');
      return { ok: true, label: '已断开' };
    default:
      throw new Error('未知指令: ' + msg.action);
  }
}

function updateBadgeOptimistic(vol) {
  try {
    chrome.action.setBadgeText({ text: String(vol) });
    chrome.action.setBadgeBackgroundColor({ color: vol === 0 ? '#8a94a6' : '#ff5f56' });
  } catch (e) {
    /* ignore */
  }
}

/** 乐观更新：让所有界面在指令下发瞬间就动起来，随后被设备回读值覆盖 */
function optimisticVolume(vol) {
  latest = Object.assign({}, latest, {
    device: Object.assign(C.emptyDevice(), latest.device, { vol: vol }),
    syncing: true
  });
  updateBadgeOptimistic(vol);
  broadcast();
}

/* ------------------------------------------------------------------ 快捷键 */

function announce(label) {
  var text = String(label || '').slice(0, 12);
  try {
    chrome.action.setBadgeText({ text: text || ' ' });
    chrome.action.setBadgeBackgroundColor({ color: '#3b4252' });
    setTimeout(function () {
      updateBadge();
    }, 1100);
  } catch (e) {
    /* ignore */
  }
}

chrome.commands.onCommand.addListener(async function (command) {
  try {
    if (command === 'toggle-panel') {
      await openPanel();
      return;
    }
    var map = { 'vol-up': 'vol_up', 'vol-down': 'vol_down', 'toggle-mute': 'mute_toggle' };
    var action = map[command];
    if (!action) return;
    var res = await runAction({ action: action });
    announce(res && res.label);
  } catch (err) {
    announce('失败');
  }
});

/* ------------------------------------------------------------------ 消息入口 */

async function handleUiMessage(msg) {
  // 任何界面请求都先等设置读出来，否则会拿着空设置回答「未配置音箱」
  await settingsReady;

  switch (msg.type) {
    case 'get_state':
      // 立刻用当前已知状态答复（界面秒开），同时在后台唤醒/校验连接桥：
      // 就绪后连接桥会主动广播，界面订阅的 onState 会收到并自动更新。
      // 这里刻意不等 —— 等的话一旦连接桥暂时起不来，界面就会一直转圈。
      wakeBridge();
      return publicState();
    case 'action':
      return runAction(msg);
    case 'settings:patch':
      await patchSettings(msg.patch);
      if (msg.patch && typeof msg.patch.ip === 'string') {
        await call('configure', { ip: C.hostOf(msg.patch.ip), auto: true }).catch(function () {});
      }
      return publicState();
    case 'panel:open':
      return { opened: await openPanel() };
    case 'panel:close':
      return { closed: await closePanel() };
    case 'bridge:reset':
      return resetBridge();
    case 'options:open':
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    default:
      throw new Error('未知消息: ' + msg.type);
  }
}

/** 后台健康快照：界面会把它显示在设置页里，出问题直接截图即可 */
function diagSnapshot() {
  return {
    bootedAt: diag.bootedAt,
    uptimeMs: Date.now() - diag.bootedAt,
    wakes: diag.wakes,
    lastRequest: diag.lastRequest,
    lastRequestAgoMs: diag.lastRequestAt ? Date.now() - diag.lastRequestAt : null,
    lastReplyAgoMs: diag.lastReplyAt ? Date.now() - diag.lastReplyAt : null,
    replies: diag.replies,
    bridge: offscreenAlive,
    status: latest.status,
    device: { host: latest.device.host, vol: latest.device.vol, max: latest.device.max },
    lastError: diag.lastError || lastBootError,
    ip: settings.ip,
    hasOffscreenApi: !!chrome.offscreen,
    hasGetContexts: !!chrome.runtime.getContexts,
    bridgeStage: diag.bridgeStage || '未开始',
    bootLog: diag.bootLog || [],
    offscreenBoot: diag.offscreenBoot
      ? diag.offscreenBoot.line +
        (diag.offscreenBoot.detail ? '（' + (typeof diag.offscreenBoot.detail === 'string' ? diag.offscreenBoot.detail : JSON.stringify(diag.offscreenBoot.detail)) + '）' : '') +
        ' · ' + Math.round((Date.now() - diag.offscreenBoot.at) / 1000) + ' 秒前'
      : '从未自报（脚本没跑起来）',
    documentCount: typeof diag.documentCount === 'number' ? diag.documentCount : null,
    offscreenHealth: diag.offscreenHealth || null
  };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;

  // 记录每一条界面请求：如果界面报「连接桥无响应」而这里没有记录，
  // 说明消息根本没到 service worker（多半是界面还挂着旧版本的上下文）
  diag.lastRequest = msg.target ? msg.target + '/' + msg.type : msg.type;
  diag.lastRequestAt = Date.now();

  if (msg.target === 'background' && msg.type === 'offscreen/state') {
    applyOffscreenState(msg.state, msg.health, msg.session);
    sendResponse({ ok: true });
    return false;
  }

  // 连接桥启动期的自报：这是「文档到底有没有跑起来」的唯一可靠证据
  if (msg.target === 'background' && msg.type === 'offscreen/boot') {
    diag.offscreenBoot = {
      line: msg.line || '',
      detail: msg.detail || '',
      at: Date.now()
    };
    // 保留完整自报历史，诊断时能看到它一路走到哪一步
    diag.bootLog = diag.bootLog || [];
    diag.bootLog.push((msg.line || '') + (msg.detail ? ' ' + JSON.stringify(msg.detail) : ''));
    if (diag.bootLog.length > 12) diag.bootLog.shift();
    diag.bridgeStage = '连接桥自报: ' + (msg.line || '');
    sendResponse({ ok: true });
    return false;
  }

  // 连接桥里 chrome.storage 不可用时，由后台把设置喂给它
  if (msg.target === 'background' && msg.type === 'settings:get') {
    sendResponse({ ok: true, result: { settings: settings } });
    return false;
  }

  // 屏幕外文档发给界面的广播
  if (msg.target === 'ui') return false;

  // 后台自检：界面能拿到「卡在哪一步」的完整快照
  if (msg.type === 'diag') {
    // 顺便问 Chrome：它到底看得见几个屏幕外文档？
    // 这一条能把「以为建好了」和「Chrome 里真的存在」区分开。
    hasOffscreen()
      .then(function (exists) {
        diag.documentCount = exists ? 1 : 0;
      })
      .catch(function () {
        diag.documentCount = -1;
      })
      .then(function () {
        sendResponse({ ok: true, result: diagSnapshot() });
      });
    return true;
  }

  // 重建连接桥是一个「明确可能很慢」的修复动作，不受下面的兜底超时约束，
  // 否则会被 3 秒看门狗掐断，界面收到 undefined（真踩过）
  if (msg.type === 'bridge:reset') {
    resetBridge()
      .then(function (result) {
        sendResponse({ ok: true, result: result });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: friendlyError(err) });
      });
    return true;
  }

  // 兜底超时：无论内部哪一步卡住，界面都能拿到一个明确的答复而不是干等。
  // 注意这个超时必须明显小于界面自己的超时，否则界面会先报「无响应」。
  withTimeout(handleUiMessage(msg), 3000, '扩展后台处理超时，请重新加载扩展')
    .then(function (result) {
      diag.replies += 1;
      diag.lastReplyAt = Date.now();
      sendResponse({ ok: true, result: result });
    })
    .catch(function (err) {
      recordError('处理 ' + (msg.type || '?'), err);
      diag.replies += 1;
      diag.lastReplyAt = Date.now();
      sendResponse({ ok: false, error: friendlyError(err) });
    });
  return true; // 异步
});

/* ------------------------------------------------------------------ 生命周期 */

chrome.runtime.onInstalled.addListener(function () {
  setupAlarm();
  // 扩展重载/更新后立刻重新握手：旧版本遗留的僵尸连接桥会被识别并替换掉。
  // onInstalled 里的 offscreenAlive 一定是 false，所以这里会走完整的验证流程。
  ensureOffscreen().catch(function () {
    /* 失败也不影响：下次唤醒还会再试 */
  });
  loadSettings().then(function () {
    updateBadge();
    if (settings.ip) callQuiet('refresh');
  });
});

async function setupAlarm() {
  try {
    await chrome.alarms.clear('r1-keepalive');
  } catch (e) {
    /* ignore */
  }
  try {
    await chrome.alarms.create('r1-keepalive', { periodInMinutes: 0.5 });
  } catch (e) {
    try {
      await chrome.alarms.create('r1-keepalive', { periodInMinutes: 1 });
    } catch (e2) {
      /* ignore */
    }
  }
}

/** 每次 service worker 被唤醒都会走到这里：补上闹钟、唤醒连接桥 */
async function bootstrap(reason) {
  diag.wakes += 1;
  try {
    await withTimeout(settingsReady, 2000, '读取设置超时');
    if (
      !(await chrome.alarms
        .get('r1-keepalive')
        .then(function (a) {
          return a;
        })
        .catch(function () {
          return null;
        }))
    ) {
      setupAlarm();
    }
    if (reason === 'startup' && !settings.autoConnect) {
      updateBadge();
      return;
    }
    // ping 只是保活/探活，真正的设备轮询由屏幕外文档自己的心跳负责
    await ensureOffscreen();
    await call('ping');
  } catch (err) {
    recordError('启动(' + reason + ')', err);
    lastBootError = (err && err.message) || String(err);
  }
  updateBadge();
}

chrome.runtime.onStartup.addListener(function () {
  bootstrap('startup');
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'r1-keepalive') bootstrap('alarm');
});

chrome.windows.onRemoved.addListener(function (id) {
  if (id === panelWindowId) panelWindowId = null;
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.settings) return;
  settings = Object.assign({}, C.DEFAULT_SETTINGS, changes.settings.newValue || {});
  updateBadge();
});

bootstrap('load');
