/**
 * 同网段扫描器：在 8080 端口上探测谁是 R1 音箱。
 *
 * 判定标准：WebSocket 能握手成功，且发送 {"type":"get_info"} 后能拿到带 vol 的 JSON。
 * 这是区分「音箱」和「随便一个开着 8080 的服务」的关键。
 */
(function (root) {
  'use strict';

  var C = root.R1;

  function withTimeout(promise, ms, onTimeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (onTimeout) onTimeout();
        reject(new Error('timeout'));
      }, ms);
      promise.then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  /** 单点探测：成功返回设备信息，失败返回 null */
  function probe(ip, opts) {
    var options = opts || {};
    var timeout = options.timeout || 1200;
    var url = C.wsUrl(ip);
    return new Promise(function (resolve) {
      var ws = null;
      var settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        try {
          if (ws) ws.close();
        } catch (e) {
          /* ignore */
        }
        resolve(result);
      }

      var timer = setTimeout(function () {
        finish(null);
      }, timeout);

      try {
        ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(timer);
        finish(null);
        return;
      }

      ws.onopen = function () {
        try {
          ws.send(JSON.stringify({ type: 'get_info' }));
        } catch (e) {
          clearTimeout(timer);
          finish(null);
        }
      };

      ws.onmessage = function (event) {
        var info = null;
        try {
          var msg = JSON.parse(event.data);
          if (msg && msg.type === 'get_info') {
            info = C.parseMaybeJson(msg.data);
          } else if (msg && msg.type === 'max_vol') {
            return;
          }
        } catch (e) {
          info = null;
        }
        if (info && typeof info === 'object' && typeof info.vol === 'number') {
          clearTimeout(timer);
          finish({
            ip: ip,
            vol: info.vol,
            max: typeof info.max_vol === 'number' ? info.max_vol : C.DEFAULT_MAX_VOL,
            hostname: info.hostname || '',
            ver: info.ver !== undefined ? String(info.ver) : '',
            raw: info
          });
        }
      };

      ws.onerror = function () {
        clearTimeout(timer);
        finish(null);
      };

      ws.onclose = function () {
        clearTimeout(timer);
        finish(null);
      };
    });
  }

  /** 读取本机 IPv4 /24 网段，返回候选地址（网关优先） */
  async function candidates(preferred) {
    var list = [];
    var seen = {};

    function push(ip) {
      if (!ip || seen[ip]) return;
      seen[ip] = true;
      list.push(ip);
    }

    push(C.hostOf(preferred));

    var base = null;
    try {
      if (chrome.system && chrome.system.network && chrome.system.network.getNetworkInterfaces) {
        var ifaces = await chrome.system.network.getNetworkInterfaces();
        ifaces.forEach(function (iface) {
          if (!iface.address || iface.address.indexOf(':') >= 0) return; // 跳过 IPv6
          var parts = iface.address.split('.');
          if (parts.length !== 4) return;
          if (!base) base = parts.slice(0, 3).join('.');
        });
      }
    } catch (e) {
      /* 权限不可用时忽略 */
    }

    // 常见家用网段兜底
    if (!base) {
      ['192.168.1', '192.168.0', '192.168.31', '10.0.0', '192.168.2'].some(function (b) {
        base = b;
        return true;
      });
    }

    push(base + '.1'); // 网关
    for (var i = 2; i <= 254; i++) push(base + '.' + i);

    ['192.168.1.12', '192.168.0.12', '192.168.31.12'].forEach(push);

    return list.slice(0, 260);
  }

  /**
   * 扫描。
   * @param {Object} opts { preferred, concurrency, timeout, onProgress, onFound }
   * @returns {Promise<{found: Array, scanned: number, stopped: boolean}>}
   */
  async function scan(opts) {
    var options = opts || {};
    var onProgress = options.onProgress || function () {};
    var onFound = options.onFound || function () {};
    var limit = options.concurrency || 24;
    var timeout = options.timeout || 1200;

    var list = await candidates(options.preferred);
    var found = [];
    var index = 0;
    var scanned = 0;
    var stopped = false;

    var api = {
      get found() {
        return found;
      },
      stop: function () {
        stopped = true;
      }
    };
    if (options.register) options.register(api);

    async function worker() {
      while (!stopped) {
        var i = index++;
        if (i >= list.length) return;
        if (found.length && options.stopOnFirst) {
          stopped = true;
          return;
        }
        var ip = list[i];
        var hit = await probe(ip, { timeout: timeout });
        scanned += 1;
        if (hit) {
          found.push(hit);
          onFound(hit);
        }
        if (scanned % 8 === 0 || hit) onProgress({ scanned: scanned, total: list.length, found: found.length, ip: ip });
      }
    }

    var workers = [];
    for (var w = 0; w < limit; w++) workers.push(worker());
    await Promise.all(workers);

    onProgress({ scanned: scanned, total: list.length, found: found.length, done: true });
    return { found: found, scanned: scanned, stopped: stopped };
  }

  root.R1Scanner = { scan: scan, probe: probe, candidates: candidates, withTimeout: withTimeout };
})(typeof self !== 'undefined' ? self : this);
