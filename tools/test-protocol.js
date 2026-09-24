/**
 * 纯逻辑单元测试（不需要音箱）：协议解析、音量规范化、步长换算。
 * 用法: node tools/test-protocol.js
 */
'use strict';

const path = require('path');
const R1 = require(path.join(__dirname, '..', 'src', 'common', 'constants.js'));

let passed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures.push(`${label}\n    期望 ${e}\n    实际 ${a}`);
  }
}

function ok(value, label) {
  if (value) passed++;
  else failures.push(`${label}（期望为真）`);
}

/* ---------------------------------------------------------------- 地址处理 */

eq(R1.hostOf('192.168.1.12'), '192.168.1.12', 'hostOf 纯 IP');
eq(R1.hostOf(' ws://192.168.1.12:8080/ '), '192.168.1.12', 'hostOf 带协议与端口');
eq(R1.hostOf('http://r1.local:8080/x'), 'r1.local', 'hostOf 主机名');
eq(R1.wsUrl('192.168.1.12'), 'ws://192.168.1.12:8080', 'wsUrl 拼接');
eq(R1.wsUrl(''), '', 'wsUrl 空值');
ok(R1.isLikelyIp('192.168.1.12'), 'isLikelyIp 合法');
ok(!R1.isLikelyIp('192.168.1.300'), 'isLikelyIp 越界');
ok(!R1.isLikelyIp(''), 'isLikelyIp 空值');
ok(R1.isLikelyIp('r1-speaker.local'), 'isLikelyIp 主机名');

/* ---------------------------------------------------------------- 数据解析 */

const rawInfo = JSON.stringify({
  vol: 7,
  hostname: 'R1-ABCD',
  ip: '192.168.1.12',
  ver: '1.8.81',
  u_ver: 1850,
  play_state: 1,
  play_mode: 2,
  music_info: { title: '起风了', artist: '买辣椒也用券', duration: 325000 }
});

const parsed = R1.parseMaybeJson(rawInfo);
eq(typeof parsed, 'object', 'parseMaybeJson 解析 JSON 字符串');
eq(parsed.vol, 7, 'parseMaybeJson 保留字段');
eq(R1.parseMaybeJson('not json'), 'not json', 'parseMaybeJson 非 JSON 原样返回');
eq(R1.parseMaybeJson(15), 15, 'parseMaybeJson 数字原样返回');

/* ---------------------------------------------------------------- 规范化 */

const dev = R1.normalizeDevice(parsed, null);
eq(dev.vol, 7, 'normalizeDevice 音量');
eq(dev.hostname, 'R1-ABCD', 'normalizeDevice 名称');
eq(dev.ver, '1.8.81', 'normalizeDevice 版本');
eq(dev.playState, 1, 'normalizeDevice 播放状态');
eq(dev.playMode, 2, 'normalizeDevice 播放模式');
eq(dev.track.title, '起风了', 'normalizeDevice 曲名');
eq(dev.track.artist, '买辣椒也用券', 'normalizeDevice 歌手');
eq(dev.track.duration, 325000, 'normalizeDevice 时长');
eq(dev.muted, false, 'normalizeDevice 未静音');
ok(dev.online === false, 'normalizeDevice 默认不在线（由连接层置位）');

const vol0 = R1.normalizeDevice({ vol: 0, hostname: 'R1' }, dev);
eq(vol0.muted, true, '音量为 0 判定为静音');
eq(vol0.hostname, 'R1', '新数据覆盖旧字段');
eq(vol0.max, R1.DEFAULT_MAX_VOL, '上限默认值保留');
eq(vol0.track, null, '无 music_info 时曲目清空');

const clamped = R1.normalizeDevice({ vol: 99, max_vol: 15 });
eq(clamped.vol, 15, '超过上限被夹紧');
const neg = R1.normalizeDevice({ vol: -5 });
eq(neg.vol, 0, '负数被夹紧到 0');
const withMax = R1.normalizeDevice({ vol: 30, max_vol: 30 });
eq(withMax.vol, 30, '自定义上限生效');

const noTrack = R1.normalizeDevice({ vol: 3, music_info: {} }, dev);
eq(noTrack.track, null, '空 music_info 归零');

// 官方固件把 artist 拼成了 arist，两个都要认
const aristOnly = R1.normalizeDevice({ vol: 3, music_info: { title: '起风了', arist: '买辣椒也用券' } });
eq(aristOnly.track.artist, '买辣椒也用券', 'arist 字段被识别为歌手');
const artistWins = R1.normalizeDevice({ vol: 3, music_info: { title: 'x', artist: 'A', arist: 'B' } });
eq(artistWins.track.artist, 'A', 'artist 优先于 arist');

// 设备用「未知」当空值，不能当真的歌手名显示
const placeholder = R1.normalizeDevice({ vol: 3, music_info: { title: 'ZHIYU', arist: '未知' } });
eq(placeholder.track.artist, '', '「未知」被当成空值清掉');
eq(placeholder.track.title, 'ZHIYU', '标题不受影响');
eq(R1.cleanText('未知'), '', 'cleanText 清掉占位符');
eq(R1.cleanText('  '), '', 'cleanText 清掉空白');
eq(R1.cleanText('起风了'), '起风了', 'cleanText 保留正常文本');

/* ---------------------------------------------------------------- 文案与步长 */

eq(R1.playStateText(0), '已停止', '播放状态文案 0');
eq(R1.playStateText(1), '播放中', '播放状态文案 1');
eq(R1.playStateText(9), '未知', '播放状态文案 越界');
eq(R1.playModeText(1), '随机播放', '播放模式文案 1');
eq(R1.playModeText(4), '列表循环', '播放模式文案 4');
eq(R1.formatTime(325000), '5:25', '时长格式化');
eq(R1.formatTime(3725000), '1:02:05', '时长格式化 带小时');
eq(R1.formatTime(-1), '00:00', '时长格式化 负数');

eq(R1.clamp(7.6, 0, 15), 8, 'clamp 四舍五入');
eq(R1.clamp(-3, 0, 15), 0, 'clamp 下限');
eq(R1.clamp('abc', 0, 15), 0, 'clamp 非法输入');

/* ---------------------------------------------------------------- 递增边界 */

function bump(vol, delta, max) {
  const base = vol === 0 && delta > 0 ? 0 : vol;
  return R1.clamp(base + delta, 0, max);
}
eq(bump(15, 1, 15), 15, '上限不再增加');
eq(bump(0, -1, 15), 0, '下限不再减少');
eq(bump(7, 2, 15), 9, '正常递增');

/* ---------------------------------------------------------------- 结果 */

console.log(`协议与状态逻辑测试：${passed} 项通过`);
if (failures.length) {
  console.log(`\n${failures.length} 项失败：`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ 全部通过');
