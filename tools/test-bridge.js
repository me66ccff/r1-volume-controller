/**
 * 连接桥集成测试：用假的 WebSocket 模拟音箱，跑真实的 offscreen.js。
 *
 * 重点验证静音链路——「发出去」不等于「设备接受了」：
 *   1. 设备正常接受 vol=0  -> muted: true
 *   2. 设备第一次吞掉命令  -> 自动重试并成功
 *   3. 设备拒绝降到 0      -> 必须回报 failed + 真实音量，不能谎报已静音
 *   4. 恢复音量用回设备真正接受过的值
 *
 * 用法: node tools/test-bridge.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONSTANTS = path.join(ROOT, 'src', 'common', 'constants.js');
const OFFSCREEN = path.join(ROOT, 'src', 'offscreen', 'offscreen.js');

let passed = 0;
const failures = [];

function ok(value, label) {
  if (value) passed++;
  else failures.push(label);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n    期望 ${e}\n    实际 ${a}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动一个沙箱：真实的 offscreen.js + 假 WebSocket + 假 chrome API。
 * @param {Object} device 假设备配置 { vol, max, clampMinTo, swallowFirstZero, includeMusicInfo }
 * @param {Object} [env]  环境配置 { orphan: true } 模拟「扩展重载后遗留的孤儿文档」
 */
function bootBridge(device, env) {
  const options = env || {};
  const state = { vol: device.vol, max: device.max || 15, zeroAttempts: 0 };

  let messageHandler = null;
  let socket = null;
  let closedBySelf = false;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      socket = this;
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
          if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
        }, 0);
      };

      if (msg.type === 'get_info') {
        const info = {
          vol: state.vol,
          hostname: 'R1-TEST',
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
        reply({ type: 'max_vol', code: 200, data: state.max });
        return;
      }

      if (msg.type === 'set_vol') {
        const want = Number(msg.vol);
        if (want === 0) {
          state.zeroAttempts += 1;
          // 有的固件首次会吞掉 vol=0
          if (device.swallowFirstZero && state.zeroAttempts === 1) return;
        }
        let next = Math.max(0, Math.min(state.max, want));
        // 有的固件把 0 钳到 1（最低音量）
        if (device.clampMinTo > 0) next = Math.max(device.clampMinTo, next);
        state.vol = next;
      }
    }
  }

  const sandbox = {
    console,
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
    WebSocket: FakeWebSocket,
    self: null,
    chrome: {
      runtime: {
        // 模拟孤儿文档：扩展重载后 chrome.runtime 已经不带 id
        id: options.orphan ? undefined : 'test-extension-id',
        onMessage: {
          addListener(fn) {
            messageHandler = fn;
          }
        },
        sendMessage() {
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          get() {
            return Promise.resolve({ settings: { ip: '192.168.1.12', step: 1 } });
          }
        },
        onChanged: { addListener() {} }
      }
    }
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.window.close = function () {
    closedBySelf = true;
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CONSTANTS, 'utf8'), sandbox, { filename: CONSTANTS });
  vm.runInContext(fs.readFileSync(OFFSCREEN, 'utf8'), sandbox, { filename: OFFSCREEN });

  function ask(type, payload) {
    return new Promise((resolve) => {
      if (!messageHandler) {
        resolve({ ok: false, error: '连接桥没有注册消息监听器' });
        return;
      }
      const done = messageHandler(
        Object.assign({ target: 'offscreen', type }, payload || {}),
        {},
        resolve
      );
      if (done !== true) resolve({ ok: false, error: '监听器没有异步应答' });
    });
  }

  return {
    ask,
    live: state,
    get handlerRegistered() {
      return !!messageHandler;
    },
    get closedBySelf() {
      return closedBySelf;
    },
    get socketCreated() {
      return socket !== null;
    },
    /** 等连接桥真正连上并完成一次状态同步，避免测试依赖时序运气 */
    async ready() {
      for (let i = 0; i < 80; i++) {
        const r = await ask('get_state');
        if (r && r.ok && r.result && r.result.status === 'online' && r.result.device && r.result.device.hostname) {
          return;
        }
        await sleep(25);
      }
      throw new Error('连接桥未能在 2 秒内连上假设备');
    },
    get socket() {
      return socket;
    }
  };
}

/* ---------------------------------------------------------------- 用例 */

async function run() {
  // 1. 正常静音 + 恢复（走真实 UI 路径：由 service worker 决定 set_mute 的取值）
  {
    const b = bootBridge({ vol: 8 });
    await b.ready();
    let r = await b.ask('set_mute', { mute: true });
    ok(r.ok, '静音指令返回 ok');
    eq(r.result.vol, 0, '设备接受 vol=0，回读为 0');
    eq(r.result.muted, true, 'muted 以回读值为准');
    eq(b.live.vol, 0, '假设备的音量确实变成 0');

    r = await b.ask('set_mute', { mute: false });
    eq(r.result.vol, 8, '再点一下恢复到静音前的 8');
    eq(r.result.muted, false, '恢复后不再是静音');
  }

  // 2. 设备首次吞掉 vol=0 -> 自动重试
  {
    const b = bootBridge({ vol: 6, swallowFirstZero: true });
    await b.ready();
    const r = await b.ask('set_mute', { mute: true });
    eq(r.result.vol, 0, '首次被吞掉后重试成功，音量到 0');
    eq(r.result.muted, true, '重试成功后判定为已静音');
    eq(b.live.zeroAttempts, 2, '确实尝试了两次');
  }

  // 3. 设备把 0 钳成 1（最低档就是 1）—— 这就是「点了没反应」的真实场景
  {
    const b = bootBridge({ vol: 5, clampMinTo: 1 });
    await b.ready();
    const down = await b.ask('set_mute', { mute: true });
    eq(down.result.vol, 1, '降到设备能接受的最低档 1');
    eq(down.result.muted, true, '降不到 0 也要判定为已静音，否则按钮永远没有反馈');
    eq(down.result.downgraded, true, '告知界面这是「降到最低」而不是真正的 0');

    // service worker 判断「当前是否静音」用的是 device.min，必须被学到
    const st = await b.ask('get_state');
    eq(st.result.device.min, 1, '探测到的静音档位被记住');
    ok(
      st.result.device.vol <= st.result.device.min,
      '界面依据 vol <= min 判定为静音（按钮会高亮）'
    );

    const up = await b.ask('set_mute', { mute: false });
    eq(up.result.vol, 5, '再点一下恢复静音前的 5');
    eq(up.result.muted, false, '恢复后不再是静音');

    // 恢复之后的普通调音量不能被误判成「取消静音」
    const again = await b.ask('set_mute', { mute: true });
    eq(again.result.vol, 1, '再次静音仍然降到最低档');
  }

  // 4. music_info 的 arist 字段要认得（官方固件就是这个拼写）
  {
    const b = bootBridge({ vol: 4, includeMusicInfo: true });
    await b.ready();
    const r = await b.ask('get_state');
    eq(r.result.device.track.title, '测试曲目', 'title 解析正确');
    eq(r.result.device.track.artist, '测试歌手', 'arist 字段被识别为歌手');
  }

  // 5. 设置音量 + 回读（常规链路）
  {
    const b = bootBridge({ vol: 3 });
    await b.ready();
    const r = await b.ask('set_vol', { vol: 11 });
    eq(r.result.vol, 11, '设置音量后回读一致');
    const up = await b.ask('bump', { delta: 2 });
    eq(up.result.vol, 13, '递增生效');
    const over = await b.ask('set_vol', { vol: 99 });
    eq(over.result.vol, 15, '超过上限被设备钳制到 15');
  }

  // 6. 开机自启：连接桥自己就该把连接建起来（不依赖 service worker 来戳）
  {
    const b = bootBridge({ vol: 2 });
    await b.ready(); // ready() 内部就是等 status === online
    ok(b.socket && b.socket.readyState === 1, '仅靠连接桥自身完成自动连接');
  }

  // 7. 孤儿屏幕外文档（扩展重载后遗留）：必须安静退出，不能刷报错、不能占着连接
  {
    const b = bootBridge({ vol: 7 }, { orphan: true });
    await sleep(60);
    eq(b.handlerRegistered, false, '上下文失效时不注册消息监听器');
    eq(b.closedBySelf, true, '主动关闭自己，让 service worker 重建一个干净的连接桥');
    eq(b.socketCreated, false, '不会再去连音箱（避免孤儿文档占住设备连接）');
  }

  console.log(`连接桥集成测试：${passed} 项通过`);
  if (failures.length) {
    console.log(`\n${failures.length} 项失败：`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✓ 全部通过');
  // 连接桥里有 20 秒心跳定时器，测试跑完必须主动退出，否则 node 会一直挂着
  process.exit(0);
}

run().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
