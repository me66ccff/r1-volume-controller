/**
 * 设置页：音箱地址、自动查找、使用习惯、快捷键、配置导入导出。
 */
(function () {
  'use strict';

  var C = self.R1;
  var UI = self.R1UI;
  var Conn = self.R1Connector;
  var Scanner = self.R1Scanner;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var el = {
    ip: $('ip'),
    btnConnect: $('btnConnect'),
    btnAuto: $('btnAuto'),
    btnPing: $('btnPing'),
    scanSpin: $('scanSpin'),
    scanHint: $('scanHint'),
    log: $('log'),
    findings: $('findings'),
    autoConnect: $('autoConnect'),
    stepChips: $('stepChips'),
    maxVol: $('maxVol'),
    btnSaveMax: $('btnSaveMax'),
    btnKeys: $('btnKeys'),
    btnExport: $('btnExport'),
    btnImport: $('btnImport'),
    btnReset: $('btnReset'),
    configBox: $('configBox'),
    saveHint: $('saveHint'),
    diag: $('diag'),
    btnDiag: $('btnDiag'),
    btnResetBridge: $('btnResetBridge'),
    dot: $('dot'),
    badgeText: $('badgeText'),
    headSub: $('headSub'),
    wantIp: $('wantIp')
  };

  var settings = Object.assign({}, C.DEFAULT_SETTINGS);
  var state = { status: 'disabled', device: C.emptyDevice() };
  var toast = UI.createToast($('toast'));
  var scanning = null;

  /* ---------------------------------------------------------------- 小工具 */

  function say(text, isError) {
    toast(text, isError);
  }

  function log(line) {
    el.log.hidden = false;
    el.log.textContent += (el.log.textContent ? '\n' : '') + line;
    el.log.scrollTop = el.log.scrollHeight;
  }

  function clearLog() {
    el.log.textContent = '';
    el.log.hidden = true;
  }

  function save(patch, silent) {
    return Conn.patchSettings(patch)
      .then(function (next) {
        settings = Object.assign({}, C.DEFAULT_SETTINGS, (next && next.settings) || settings);
        paintSettings();
        if (!silent) {
          el.saveHint.textContent = '已保存 ' + new Date().toLocaleTimeString();
          setTimeout(function () {
            el.saveHint.textContent = '';
          }, 2600);
        }
        return next;
      })
      .catch(function (err) {
        say(err.message, true);
      });
  }

  /* ---------------------------------------------------------------- 渲染 */

  function paintSettings() {
    if (document.activeElement !== el.ip) el.ip.value = settings.ip || '';
    el.autoConnect.checked = !!settings.autoConnect;
    el.wantIp.textContent = settings.ip ? '当前：' + settings.ip : '例如 192.168.1.12';
    if (document.activeElement !== el.maxVol) el.maxVol.value = String(state.device.max || C.DEFAULT_MAX_VOL);
    Array.prototype.forEach.call(el.stepChips.children, function (chip) {
      chip.classList.toggle('is-active', Number(chip.dataset.step) === settings.step);
    });
  }

  function applyState(next) {
    if (!next) return;
    state = { status: next.status, device: Object.assign(C.emptyDevice(), next.device || {}) };
    if (next.settings) settings = Object.assign({}, C.DEFAULT_SETTINGS, next.settings);
    paintState();
    paintSettings();
  }

  function paintState() {
    var online = state.status === 'online';
    var cls = 'dot';
    var text = '';
    if (!settings.ip) text = '未配置地址';
    else if (online) {
      cls += ' dot--online';
      text = '已连接 · 音量 ' + state.device.vol + '/' + state.device.max;
    } else if (state.status === 'connecting') {
      cls += ' dot--connecting';
      text = '连接中…';
    } else {
      cls += ' dot--offline';
      text = '未连接';
    }
    el.dot.className = cls;
    el.badgeText.textContent = text;
    if (online) {
      el.headSub.textContent =
        '已连上 ' + (state.device.hostname || state.device.host) + (state.device.ver ? '（EchoService ' + state.device.ver + '）' : '');
    } else {
      el.headSub.textContent = '填写音箱地址，浏览器一打开就自动连上。';
    }
    if (document.activeElement !== el.maxVol) el.maxVol.value = String(state.device.max || C.DEFAULT_MAX_VOL);
  }

  function buildSteps() {
    el.stepChips.innerHTML = '';
    [1, 2, 3, 5].forEach(function (step) {
      var btn = document.createElement('button');
      btn.className = 'chip chip--step' + (settings.step === step ? ' is-active' : '');
      btn.dataset.step = String(step);
      btn.textContent = String(step);
      btn.title = '每次增减 ' + step + ' 级';
      btn.addEventListener('click', function () {
        save({ step: step });
      });
      el.stepChips.appendChild(btn);
    });
  }

  function addFinding(hit) {
    el.findings.hidden = false;
    var li = document.createElement('li');
    var name = hit.hostname || 'R1 音箱';
    li.innerHTML =
      '<b>' +
      hit.ip +
      '</b><span class="grow">' +
      name +
      ' · 音量 ' +
      hit.vol +
      '/' +
      hit.max +
      (hit.ver ? ' · 服务 ' + hit.ver : '') +
      '</span>';
    var use = document.createElement('button');
    use.className = 'pill pill--accent';
    use.textContent = '使用它';
    use.addEventListener('click', function () {
      el.ip.value = hit.ip;
      save({ ip: hit.ip }).then(function () {
        say('已切换到 ' + hit.ip);
        return Conn.act('connect', { ip: hit.ip });
      });
    });
    li.appendChild(use);
    el.findings.appendChild(li);
  }

  /* ---------------------------------------------------------------- 交互 */

  el.btnConnect.addEventListener('click', function () {
    var ip = C.hostOf(el.ip.value);
    if (!ip) {
      say('请先填写音箱 IP', true);
      return;
    }
    if (!C.isLikelyIp(ip)) {
      say('IP 格式看起来不对：' + ip, true);
      return;
    }
    clearLog();
    log('→ 保存地址 ' + ip + ' 并连接…');
    save({ ip: ip }, true)
      .then(function () {
        return Conn.act('connect', { ip: ip });
      })
      .then(function () {
        say('正在连接 ' + ip);
      })
      .catch(function (err) {
        say(err.message, true);
      });
  });

  el.btnPing.addEventListener('click', function () {
    var ip = C.hostOf(el.ip.value) || settings.ip;
    if (!ip) {
      say('请先填写音箱 IP', true);
      return;
    }
    clearLog();
    el.findings.hidden = true;
    el.findings.innerHTML = '';
    el.scanSpin.classList.add('is-on');
    log('→ 测试 ' + ip + ':' + C.R1_PORT + ' …');
    var started = Date.now();
    Scanner.probe(ip, { timeout: 4000 }).then(function (hit) {
      el.scanSpin.classList.remove('is-on');
      if (hit) {
        log('✓ 连接成功（' + (Date.now() - started) + 'ms）');
        log('  名称: ' + (hit.hostname || '未知'));
        log('  音量: ' + hit.vol + '/' + hit.max);
        if (hit.ver) log('  EchoService: ' + hit.ver);
        say('连接正常，可以点“连接”接管它');
        addFinding(hit);
      } else {
        log('✗ 连不上。请检查：');
        log('  1. 音箱是否开机、和电脑在同一个 Wi-Fi/局域网；');
        log('  2. IP 是否正确（可在路由器后台或音箱 App 里查看）；');
        log('  3. 8080 端口是否被防火墙拦截。');
        say('连接失败', true);
      }
    });
  });

  el.btnAuto.addEventListener('click', function () {
    if (scanning) {
      scanning.stop();
      scanning = null;
      el.scanSpin.classList.remove('is-on');
      el.btnAuto.textContent = '自动查找音箱';
      say('已停止扫描');
      return;
    }
    clearLog();
    el.findings.hidden = true;
    el.findings.innerHTML = '';
    log('→ 开始扫描同网段 8080 端口（并发 24，逐个握手验证）…');
    el.btnAuto.textContent = '停止扫描';
    el.scanSpin.classList.add('is-on');
    Scanner.scan({
      preferred: el.ip.value || settings.ip,
      concurrency: 24,
      timeout: 1200,
      register: function (api) {
        scanning = api;
      },
      onFound: function (hit) {
        log('✓ 发现音箱 ' + hit.ip + (hit.hostname ? '（' + hit.hostname + '）' : ''));
        addFinding(hit);
      },
      onProgress: function (p) {
        el.scanHint.textContent = '已扫描 ' + p.scanned + '/' + p.total + '，发现 ' + p.found + ' 台';
      }
    })
      .then(function (res) {
        scanning = null;
        el.scanSpin.classList.remove('is-on');
        el.btnAuto.textContent = '自动查找音箱';
        if (res.found.length) {
          el.scanHint.textContent = '扫描完成，找到 ' + res.found.length + ' 台设备';
          say('找到 ' + res.found.length + ' 台，点上方的“使用它”即可');
        } else {
          el.scanHint.textContent = '没有找到设备，可手动填写 IP';
          log('✗ 未发现音箱。可尝试手动填写 IP 后点“测试连接”。');
          say('没有找到设备', true);
        }
      })
      .catch(function (err) {
        scanning = null;
        el.scanSpin.classList.remove('is-on');
        el.btnAuto.textContent = '自动查找音箱';
        log('✗ 扫描出错: ' + err.message);
        say('扫描出错：' + err.message, true);
      });
  });

  el.autoConnect.addEventListener('change', function () {
    save({ autoConnect: el.autoConnect.checked });
  });

  el.btnSaveMax.addEventListener('click', function () {
    var n = Math.round(Number(el.maxVol.value));
    if (!isFinite(n) || n < 1 || n > 60) {
      say('上限需要在 1~60 之间', true);
      return;
    }
    Conn.act('set_max', { max: n })
      .then(function () {
        say('音量上限已设为 ' + n);
      })
      .catch(function (err) {
        say(err.message, true);
      });
  });

  /** 读取后台自检快照：出问题时用户直接截图即可 */
  function loadDiag() {
    el.btnDiag.disabled = true;
    var started = Date.now();
    Conn.call({ type: 'diag' })
      .then(function (info) {
        var lines = [
          '后台应答    : 正常（' + (Date.now() - started) + 'ms）',
          '运行时长    : ' + Math.round(info.uptimeMs / 1000) + ' 秒，被唤醒 ' + info.wakes + ' 次',
          '已应答请求  : ' + info.replies + ' 条',
          '最后请求    : ' +
            (info.lastRequest || '无') +
            (info.lastRequestAgoMs === null ? '' : '（' + Math.round(info.lastRequestAgoMs / 1000) + ' 秒前）'),
          '最后应答    : ' + (info.lastReplyAgoMs === null ? '无' : Math.round(info.lastReplyAgoMs / 1000) + ' 秒前'),
          '连接桥      : ' + (info.bridge ? '已存在' : '不存在'),
          '连接状态    : ' + info.status,
          '音箱        : ' + (info.device.host || '未设置') + '，音量 ' + info.device.vol + '/' + info.device.max,
          '配置 IP     : ' + (info.ip || '（空）'),
          'offscreen   : ' + (info.hasOffscreenApi ? 'API 可用' : 'API 不可用（内核过旧）'),
          'getContexts : ' + (info.hasGetContexts ? '可用' : '不可用（内核过旧）'),
          '建桥进度    : ' + (info.bridgeStage || '未知'),
          '连接桥自报  : ' + (info.offscreenBoot || '未知'),          'Chrome 看到的文档数: ' +
            (info.documentCount === null ? '未知' : info.documentCount < 0 ? '查询失败' : info.documentCount) +
            '（1=存在，0=不存在）',
          '最后错误    : ' + (info.lastError || '无')
        ];
        var oh = info.offscreenHealth;
        if (info.bootLog && info.bootLog.length) {
          lines.push('', '— 连接桥启动过程 —');
          info.bootLog.forEach(function (line) {
            lines.push('  ' + line);
          });
        }
        if (oh) {
          lines.push(
            '',
            '— 连接桥内部 —',
            '已处理消息  : ' + oh.handled + ' 条，最后一条 ' + (oh.lastHandled || '无'),
            '最后处理时间: ' + (oh.lastHandledAt ? Math.round((Date.now() - oh.lastHandledAt) / 1000) + ' 秒前' : '无'),
            '最后发出请求: ' +
              (oh.lastSent || '无') +
              (oh.lastSentAt ? '（' + Math.round((Date.now() - oh.lastSentAt) / 1000) + ' 秒前）' : ''),
            '握手 nonce  : ' + (oh.nonce ? oh.nonce.slice(0, 12) + '…' : '（未持有）'),
            'WebSocket   : 建立 ' + oh.socketOpens + ' 次，断开 ' + oh.socketCloses + ' 次' +
              (oh.lastCloseCode === null ? '' : '，最后关闭码 ' + oh.lastCloseCode),
            '内部异常    : ' + (oh.lastThrow || '无')
          );
        } else {
          lines.push('', '— 连接桥内部 —', '连接桥从未上报过状态（可能没建起来，或上下文已失效）');
        }
        el.diag.textContent = lines.join('\n');
      })
      .catch(function (err) {
        el.diag.textContent =
          '后台无应答：' +
          err.message +
          '\n\n这说明扩展后台（service worker）没有回应。\n' +
          '请在 chrome://extensions 点一次本扩展的「重新加载」，然后重新打开本页。';
      })
      .then(function () {
        el.btnDiag.disabled = false;
      });
  }

  el.btnDiag.addEventListener('click', loadDiag);
  setTimeout(loadDiag, 300);

  el.btnResetBridge.addEventListener('click', function () {
    el.diag.textContent = '正在重建连接桥…（最多约 20 秒）';
    Conn.call({ type: 'bridge:reset' }, 25000)
      .then(function (res) {
        if (res && res.rebuilt && res.bridge) {
          say('连接桥已重建');
        } else {
          say('重建后仍不可用：' + ((res && res.error) || '未知原因'), true);
        }
        return loadDiag();
      })
      .catch(function (err) {
        el.diag.textContent = '重建失败：' + err.message;
        say('重建失败', true);
      });
  });

  el.btnKeys.addEventListener('click', function () {
    var url = 'chrome://extensions/shortcuts';
    try {
      var p = chrome.tabs.create({ url: url });
      if (p && typeof p.catch === 'function') {
        // 扩展不允许打开 chrome:// 页面，此时给出可操作的提示
        p.catch(function () {
          say('请在地址栏手动打开 ' + url, true);
        });
      }
    } catch (e) {
      say('请在地址栏手动打开 ' + url, true);
    }
  });

  el.btnExport.addEventListener('click', function () {
    el.configBox.value = JSON.stringify({ version: 1, settings: settings }, null, 2);
    el.configBox.select();
    say('已生成配置，复制走即可');
  });

  el.btnImport.addEventListener('click', function () {
    var text = el.configBox.value.trim();
    if (!text) {
      say('请先把配置 JSON 粘贴到下面的文本框', true);
      return;
    }
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      say('JSON 解析失败：' + e.message, true);
      return;
    }
    var next = Object.assign({}, C.DEFAULT_SETTINGS, data.settings || data);
    next.ip = C.hostOf(next.ip);
    next.step = C.clamp(next.step || 1, 1, 30);
    save(next, true).then(function () {
      say('配置已导入');
      if (next.ip) Conn.act('connect', { ip: next.ip }).catch(function () {});
    });
  });

  el.btnReset.addEventListener('click', function () {
    save(Object.assign({}, C.DEFAULT_SETTINGS), true).then(function () {
      say('已恢复默认设置');
    });
  });

  el.ip.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') el.btnConnect.click();
  });

  Conn.onState(function (next) {
    if (!next) return;
    state = { status: next.status, device: Object.assign(C.emptyDevice(), next.device || {}) };
    if (next.settings) settings = Object.assign({}, C.DEFAULT_SETTINGS, next.settings);
    paintState();
    paintSettings();
  });

  /* ---------------------------------------------------------------- 启动 */

  UI.hydrateIcons(document);
  buildSteps();
  paintSettings();
  paintState();

  Conn.getState()
    .then(function (next) {
      if (!next) return;
      state = { status: next.status, device: Object.assign(C.emptyDevice(), next.device || {}) };
      if (next.settings) settings = Object.assign({}, C.DEFAULT_SETTINGS, next.settings);
      paintState();
      paintSettings();
      if (!settings.ip) el.ip.focus();
    })
    .catch(function (err) {
      say(err.message, true);
    });
})();
