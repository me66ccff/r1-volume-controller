/**
 * 全局常量与纯工具函数。
 * 该文件会被 service worker 通过 importScripts 加载，也会被扩展页面通过 <script> 加载，
 * 因此只使用最基础的语法，并挂在全局对象 self 上。
 */
(function (root) {
  'use strict';

  /** R1 音箱 EchoService 的 WebSocket 端口 */
  var R1_PORT = 8080;

  /** 音量绝对值上限（设备会通过 max_vol 告知真实上限，这里是兜底值） */
  var DEFAULT_MAX_VOL = 15;

  /** 每次请求设备状态的节流窗口：窗口内复用缓存，避免频繁打扰音箱 */
  var FRESH_WINDOW = 1500;

  /** set_vol 之后等待设备生效的时间 */
  var SETTLE_MS = 420;

  /** 单条请求超时 */
  var REQUEST_TIMEOUT = 4000;

  /** 播放状态文案 */
  var PLAY_STATE_TEXT = ['已停止', '播放中', '已暂停', '加载中'];

  /** 播放模式文案 */
  var PLAY_MODE_TEXT = ['随机播放', '顺序播放', '单曲循环', '列表循环'];

  var SETTINGS_KEY = 'settings';
  var STATE_KEY = 'lastState';

  var DEFAULT_SETTINGS = {
    ip: '', // 音箱 IP，例如 192.168.1.12
    step: 1, // 单次增减步长
    autoConnect: true, // 浏览器启动后自动连接
    rememberVolume: true, // 恢复上次音量
    showOrb: false, // 是否在普通网页右下角显示悬浮球
    confirmConnect: true, // 连接前先做一次握手确认
    theme: 'dark'
  };

  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) n = min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function hostOf(ip) {
    return String(ip || '')
      .trim()
      .replace(/^wss?:\/\//i, '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  function wsUrl(ip) {
    var host = hostOf(ip);
    return host ? 'ws://' + host + ':' + R1_PORT : '';
  }

  function isLikelyIp(ip) {
    var host = hostOf(ip);
    if (!host) return false;
    var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*$/i.test(host);
    for (var i = 1; i <= 4; i++) {
      if (Number(m[i]) > 255) return false;
    }
    return true;
  }

  /** 统一解析设备返回的 data（可能是 JSON 字符串，也可能是对象） */
  function parseMaybeJson(data) {
    if (typeof data !== 'string') return data;
    var s = data.trim();
    if (!s) return data;
    if (s.charAt(0) !== '{' && s.charAt(0) !== '[') return data;
    try {
      return JSON.parse(s);
    } catch (e) {
      return data;
    }
  }

  function playStateText(code) {
    return PLAY_STATE_TEXT[Number(code)] || '未知';
  }

  function playModeText(code) {
    return PLAY_MODE_TEXT[Number(code) - 1] || '未知';
  }

  /** 毫秒 -> 03:12 */
  function formatTime(ms) {
    var total = Math.floor(Number(ms) / 1000);
    if (!isFinite(total) || total < 0) return '00:00';
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function emptyDevice() {
    return {
      online: false,
      host: '',
      vol: 0,
      max: DEFAULT_MAX_VOL,
      // 设备的「静音档位」：绝大多数固件是 0，个别固件会把 0 钳成 1，
      // 探测到之后记在这里，界面用它判断是否静音
      min: 0,
      // 静音前记住的音量，专门用于「再点一下恢复」
      muteRestore: null,
      muted: false,
      lastNonZero: null,
      hostname: '',
      ip: '',
      ver: '',
      uVer: '',
      playState: -1,
      playMode: -1,
      track: null
    };
  }

  var PLACEHOLDER_TEXT = /^(未知|未知歌手|未知歌曲|null|undefined|none|n\/a|-{1,2})$/i;

  /** 清掉设备返回的占位符（有的固件会用「未知」当空值） */
  function cleanText(value) {
    if (value === null || value === undefined) return '';
    var s = String(value).trim();
    if (!s || PLACEHOLDER_TEXT.test(s)) return '';
    return s;
  }

  /** 把设备原始 JSON 规范化成扩展内部统一结构 */
  function normalizeDevice(raw, prev) {
    var d = prev ? Object.assign(emptyDevice(), prev) : emptyDevice();
    if (!raw || typeof raw !== 'object') return d;

    if (typeof raw.max_vol === 'number' && raw.max_vol > 0) d.max = raw.max_vol;
    else if (typeof raw.maxVol === 'number' && raw.maxVol > 0) d.max = raw.maxVol;

    if (typeof raw.vol === 'number') d.vol = clamp(raw.vol, 0, d.max || DEFAULT_MAX_VOL);
    if (raw.hostname) d.hostname = String(raw.hostname);
    if (raw.ip) d.ip = String(raw.ip);
    if (raw.ver !== undefined) d.ver = String(raw.ver);
    if (raw.u_ver !== undefined) d.uVer = String(raw.u_ver);
    if (typeof raw.play_state === 'number') d.playState = raw.play_state;
    if (typeof raw.play_mode === 'number') d.playMode = raw.play_mode;

    var mi = raw.music_info;
    if (mi && typeof mi === 'object') {
      // 官方控制页用的是 title / artist，但部分固件把它拼成了 arist，两个都要认
      var title = cleanText(mi.title || mi.name);
      var artist = cleanText(mi.artist || mi.arist);
      d.track = {
        title: title,
        artist: artist,
        album: cleanText(mi.album),
        duration: Number(mi.duration) || 0
      };
      if (!d.track.title && !d.track.artist) d.track = null;
    } else {
      d.track = null;
    }

    d.vol = clamp(d.vol, 0, d.max);
    d.muted = d.vol === 0;
    if (d.vol > 0) d.lastNonZero = d.vol;
    return d;
  }

  var R1 = {
    R1_PORT: R1_PORT,
    DEFAULT_MAX_VOL: DEFAULT_MAX_VOL,
    FRESH_WINDOW: FRESH_WINDOW,
    SETTLE_MS: SETTLE_MS,
    REQUEST_TIMEOUT: REQUEST_TIMEOUT,
    SETTINGS_KEY: SETTINGS_KEY,
    STATE_KEY: STATE_KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    clamp: clamp,
    hostOf: hostOf,
    wsUrl: wsUrl,
    isLikelyIp: isLikelyIp,
    parseMaybeJson: parseMaybeJson,
    playStateText: playStateText,
    playModeText: playModeText,
    formatTime: formatTime,
    cleanText: cleanText,
    emptyDevice: emptyDevice,
    normalizeDevice: normalizeDevice
  };

  root.R1 = R1;
  if (typeof module !== 'undefined' && module.exports) module.exports = R1;
})(typeof self !== 'undefined' ? self : this);
