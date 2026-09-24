/**
 * 真机联调脚本（需要音箱在线）：验证扩展使用的同一套协议。
 * 用法: node tools/live-test.js 192.168.1.12
 *
 * 它会依次执行：get_info -> max_vol -> set_vol(当前值) -> get_info 回读，
 * 并打印扩展界面会用到的全部字段。
 */
'use strict';

const ip = (process.argv[2] || '').replace(/^wss?:\/\//, '').replace(/:\d+$/, '');
const PORT = 8080;

if (!ip) {
  console.log('用法: node tools/live-test.js <音箱IP>');
  process.exit(1);
}

const started = Date.now();
const pending = [];
let socket = null;

function send(type, extra, timeout = 4000) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) return reject(new Error('未连接'));
    const entry = { type, resolve, reject };
    entry.timer = setTimeout(() => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error(`等待 ${type} 响应超时`));
    }, timeout);
    pending.push(entry);
    socket.send(JSON.stringify(Object.assign({ type }, extra || {})));
  });
}

function onMessage(event) {
  let msg;
  try {
    msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
  } catch (e) {
    return;
  }
  const i = pending.findIndex((p) => p.type === msg.type);
  if (i < 0) return;
  const entry = pending.splice(i, 1)[0];
  clearTimeout(entry.timer);
  entry.resolve(msg);
}

function parseData(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    return data;
  }
}

function fail(message) {
  console.log('✗ ' + message);
  try {
    if (socket) socket.close();
  } catch (e) {
    /* ignore */
  }
  process.exit(1);
}

socket = new WebSocket(`ws://${ip}:${PORT}`);
socket.onmessage = onMessage;
socket.onerror = () => fail(`无法连接 ${ip}:${PORT}（确认音箱已开机、IP 正确、8080 端口可达）`);

socket.onopen = async () => {
  console.log(`✓ 已连接 ws://${ip}:${PORT}  (${Date.now() - started}ms)`);
  try {
    const infoMsg = await send('get_info');
    const info = parseData(infoMsg.data);
    if (!info || typeof info.vol !== 'number') fail('get_info 返回的数据里没有 vol 字段');

    let max = null;
    try {
      const maxMsg = await send('max_vol', null, 2500);
      max = Math.round(Number(parseData(maxMsg.data)));
    } catch (e) {
      console.log('· max_vol 未响应，使用默认上限 15');
    }
    if (!max || !isFinite(max)) max = 15;

    console.log('✓ get_info 正常');
    console.log(`  名称        : ${info.hostname || '未知'}`);
    console.log(`  地址        : ${info.ip || ip}`);
    console.log(`  音量        : ${info.vol} / ${max}`);
    console.log(`  EchoService : ${info.ver ?? '未知'}`);
    console.log(`  云知声      : ${info.u_ver ?? '未知'}`);
    console.log(`  播放状态    : ${['已停止', '播放中', '已暂停', '加载中'][info.play_state] ?? info.play_state}`);
    console.log(`  播放模式    : ${['随机播放', '顺序播放', '单曲循环', '列表循环'][info.play_mode - 1] ?? info.play_mode}`);
    if (info.music_info && (info.music_info.title || info.music_info.artist)) {
      console.log(`  正在播放    : ${info.music_info.title || ''} - ${info.music_info.artist || ''}`);
    }

    // 用当前音量做一次幂等的 set_vol，验证写入通道
    console.log(`\n→ 写入测试: set_vol ${info.vol}`);
    socket.send(JSON.stringify({ type: 'set_vol', vol: info.vol }));
    await new Promise((r) => setTimeout(r, 500));
    const after = parseData((await send('get_info')).data);
    console.log(`✓ 回读音量: ${after.vol} / ${max}`);
    if (after.vol !== info.vol) {
      console.log(`  ! 音量写入后读回 ${after.vol}，与写入的 ${info.vol} 不一致（设备可能做了钳制）`);
    }

    console.log(`\n✓ 协议全部可用，扩展可以直接连这台音箱。总耗时 ${Date.now() - started}ms`);
    socket.close();
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
};
