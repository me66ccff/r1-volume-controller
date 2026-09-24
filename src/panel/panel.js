/**
 * 悬浮控制面板（独立小窗口，始终置顶）。
 * 与弹窗共用同一套状态来源与组件，因此两个界面永远同步。
 */
(function () {
  'use strict';

  var C = self.R1;
  var UI = self.R1UI;
  var Conn = self.R1Connector;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var el = {
    app: $('app'),
    deviceName: $('deviceName'),
    dot: $('dot'),
    statusText: $('statusText'),
    spin: $('spin'),
    cardUnset: $('cardUnset'),
    cardOffline: $('cardOffline'),
    offlineTitle: $('offlineTitle'),
    offlineDesc: $('offlineDesc'),
    knob: $('knob'),
    knobNum: $('knobNum'),
    slider: $('slider'),
    sliderRead: $('sliderRead'),
    presets: $('presets'),
    steps: $('steps'),
    btnUp: $('btnUp'),
    btnDown: $('btnDown'),
    btnMute: $('btnMute'),
    stepLabel: $('stepLabel'),
    stepLabel2: $('stepLabel2'),
    btnSetup: $('btnSetup'),
    btnReconnect: $('btnReconnect'),
    btnRefresh: $('btnRefresh'),
    btnReboot: $('btnReboot'),
    btnOptions: $('btnOptions'),
    btnClose: $('btnClose'),
    btnPrev: $('btnPrev'),
    btnPlay: $('btnPlay'),
    btnNext: $('btnNext'),
    nowTitle: $('nowTitle'),
    nowArtist: $('nowArtist'),
    infoHost: $('infoHost'),
    infoIp: $('infoIp'),
    infoVol: $('infoVol'),
    infoPlay: $('infoPlay'),
    infoMode: $('infoMode'),
    infoVer: $('infoVer'),
    footerNote: $('footerNote'),
    dragbar: $('dragbar')
  };

  var status = 'disabled';
  var device = C.emptyDevice();
  var settings = Object.assign({}, C.DEFAULT_SETTINGS);
  var knob = null;
  var slider = null;
  var toast = UI.createToast($('toast'));
  var acceptVolume = UI.createDeduper(350);
  var pending = 0;
  var paintedPreset = -1;
  var dragging = false;
  var confirmTimer = null;

  function say(text, isError) {
    toast(text, isError);
  }

  /* ---------------------------------------------------------------- 渲染 */

  function updateStatus() {
    var cls = 'dot';
    var text = '';
    if (!settings.ip) text = '未配置音箱地址';
    else if (status === 'online') {
      cls += ' dot--online';
      text = '已连接 · ' + (device.host || settings.ip);
    } else if (status === 'connecting') {
      cls += ' dot--connecting';
      text = '正在连接 ' + (device.host || settings.ip) + ' …';
    } else if (status === 'offline') {
      cls += ' dot--offline';
      text = '连接断开 · 自动重连中';
    } else text = '已断开';

    el.dot.className = cls;
    el.statusText.textContent = text;
    el.spin.classList.toggle('is-on', status === 'connecting' || !!device.syncing);

    var online = status === 'online';
    // 只有「确实没配地址」才提示去设置；连上了就什么都不显示
    var hasIp = !!C.hostOf(settings.ip);
    var showOffline = hasIp && !online && status !== 'connecting';
    el.cardUnset.hidden = hasIp;
    el.cardOffline.hidden = !showOffline;
    el.offlineTitle.textContent = '连接不上 ' + (device.host || settings.ip);
    el.offlineDesc.textContent = device.lastError || '确认音箱已开机、IP 正确后点重连';
    el.app.setAttribute('data-state', !settings.ip ? 'disabled' : online ? 'online' : 'offline');
    el.deviceName.textContent = device.hostname || settings.ip || 'R1 音箱';

    [el.slider, el.btnUp, el.btnDown, el.btnMute, el.btnPrev, el.btnPlay, el.btnNext, el.btnReboot].forEach(
      function (node) {
        node.disabled = !online;
      }
    );
  }

  function paintVolume(vol, max) {
    var ratio = max > 0 ? Math.min(1, vol / max) : 0;
    knob.paint(vol);
    slider.paint(vol);
    el.sliderRead.textContent = vol + ' / ' + max + '（' + Math.round(ratio * 100) + '%）';

    // 静音判定用设备能接受的最低档位（多数是 0，个别固件是 1），不是死认 0
    var floor = Number(device.min) || 0;
    var muted = vol <= floor;
    el.btnMute.classList.toggle('is-active', muted);
    el.btnMute.innerHTML = UI.icon(muted ? 'mute' : 'volume');
    el.btnMute.title = muted ? '恢复音量' : '静音';
    var active = presetValue(vol, max);
    if (active !== paintedPreset) {
      paintedPreset = active;
      Array.prototype.forEach.call(el.presets.children, function (chip) {
        chip.classList.toggle('is-active', Number(chip.dataset.vol) === active);
      });
    }
  }

  function presetValue(vol, max) {
    var list = presetList(max);
    for (var i = 0; i < list.length; i++) if (list[i] === vol) return vol;
    for (var j = 0; j < list.length; j++) if (Math.abs(list[j] - vol) <= 1) return list[j];
    return -1;
  }

  function presetList(max) {
    var seen = {};
    return [0, 3, 5, 8, 10, 12, max]
      .filter(function (v) {
        if (v < 0 || v > max || seen[v]) return false;
        seen[v] = true;
        return true;
      })
      .sort(function (a, b) {
        return a - b;
      });
  }

  function buildPresets(max) {
    var list = presetList(max);
    var key = list.join(',');
    if (el.presets.dataset.key === key) return;
    el.presets.dataset.key = key;
    paintedPreset = -1;
    el.presets.innerHTML = '';
    list.forEach(function (v) {
      var btn = document.createElement('button');
      btn.className = 'chip';
      btn.dataset.vol = String(v);
      btn.textContent = v === 0 ? '静音' : v === max ? '最大' : String(v);
      btn.addEventListener('click', function () {
        setVolume(v);
      });
      el.presets.appendChild(btn);
    });
  }

  function buildSteps() {
    el.steps.querySelectorAll('.chip').forEach(function (n) {
      n.remove();
    });
    [1, 2, 3, 5].forEach(function (step) {
      var btn = document.createElement('button');
      btn.className = 'chip chip--step' + (settings.step === step ? ' is-active' : '');
      btn.dataset.step = String(step);
      btn.textContent = '+' + step;
      btn.addEventListener('click', function () {
        settings.step = step;
        Conn.patchSettings({ step: step }).catch(function () {});
        el.stepLabel.textContent = String(step);
        el.stepLabel2.textContent = String(step);
        el.steps.querySelectorAll('.chip').forEach(function (n) {
          n.classList.toggle('is-active', Number(n.dataset.step) === step);
        });
        say('步长已设为 ' + step);
      });
      el.steps.appendChild(btn);
    });
  }

  function paintNow() {
    var t = device.track;
    if (t && (t.title || t.artist)) {
      el.nowTitle.textContent = t.title || '未知曲目';
      el.nowArtist.textContent =
        (t.artist || '未知歌手') +
        (t.duration ? ' · ' + C.formatTime(t.duration) : '') +
        ' · ' +
        C.playStateText(device.playState);
    } else {
      el.nowTitle.textContent = status === 'online' ? '暂无播放信息' : '未连接';
      el.nowArtist.textContent = status === 'online' ? C.playStateText(device.playState) : '—';
    }
    el.btnPlay.innerHTML = UI.icon(device.playState === 1 ? 'pause' : 'play');
    el.btnPlay.title = device.playState === 1 ? '暂停' : '播放';

    el.infoHost.textContent = device.hostname || '—';
    el.infoIp.textContent = device.ip || device.host || settings.ip || '—';
    el.infoVol.textContent = device.vol + ' / ' + device.max;
    el.infoPlay.textContent = status === 'online' ? C.playStateText(device.playState) : '—';
    el.infoMode.textContent = device.playMode >= 1 ? C.playModeText(device.playMode) : '—';
    el.infoVer.textContent = device.ver || '—';

    var bits = [];
    bits.push('音量 ' + device.vol + '/' + device.max);
    if (device.ver) bits.push('服务 ' + device.ver);
    if (device.uVer) bits.push('云知声 ' + device.uVer);
    el.footerNote.textContent = bits.join(' · ');
  }

  function render() {
    buildPresets(device.max);
    updateStatus();
    dragging = knob.dragging || slider.dragging;
    if (!dragging) paintVolume(device.vol, device.max);
    paintNow();
  }

  /* ---------------------------------------------------------------- 动作 */

  function applyState(next) {
    if (!next) return;
    status = next.status;
    device = Object.assign(C.emptyDevice(), next.device || {});
    device.syncing = next.syncing;
    device.lastError = next.lastError;
    if (next.settings) {
      settings = Object.assign({}, C.DEFAULT_SETTINGS, next.settings);
      el.stepLabel.textContent = String(settings.step);
      el.stepLabel2.textContent = String(settings.step);
    }
    render();
  }

  function run(action, payload) {
    pending += 1;
    el.spin.classList.add('is-on');
    return Conn.act(action, payload)
      .then(function (res) {
        if (res && res.label && !res.unchanged) say(res.label);
        else if (res && res.unchanged) say('已经到极限了');
        return res;
      })
      .catch(function (err) {
        say(err.message || '操作失败', true);
        throw err;
      })
      .then(
        function (res) {
          done();
          return res;
        },
        function (err) {
          done();
          throw err;
        }
      );
  }

  function done() {
    pending -= 1;
    if (pending <= 0) {
      pending = 0;
      el.spin.classList.remove('is-on');
    }
  }

  function setVolume(vol) {
    if (!acceptVolume(vol)) return Promise.resolve(null);
    paintVolume(vol, device.max);
    return run('set_vol', { vol: vol }).catch(function () {});
  }

  function bump(delta) {
    var target = C.clamp(device.vol + delta, 0, device.max);
    acceptVolume(target); // 记入去重窗口，避免紧随其后的重复指令
    paintVolume(target, device.max);
    return run('bump', { delta: delta }).catch(function () {});
  }

  /* ---------------------------------------------------------------- 绑定 */

  knob = UI.createKnob({
    el: el.knob,
    max: device.max,
    value: device.vol,
    onLive: function (v) {
      paintVolume(v, device.max);
    },
    onCommit: function (v) {
      setVolume(v);
    },
    onDouble: function () {
      toggleMute();
    }
  });

  slider = UI.createSlider({
    input: el.slider,
    max: device.max,
    value: device.vol,
    onLive: function (v) {
      paintVolume(v, device.max);
    },
    onCommit: function (v) {
      setVolume(v);
    }
  });

  /** 静音开关：点一下降到最低档，再点一下恢复刚才的音量 */
  function toggleMute() {
    return run('mute_toggle', {})
      .then(function (res) {
        if (res && res.downgraded) say('这台音箱的最低音量是 ' + res.vol + '，已降到最低');
        return res;
      })
      .catch(function () {});
  }

  el.btnUp.addEventListener('click', function () {
    bump(settings.step || 1);
  });
  el.btnDown.addEventListener('click', function () {
    bump(-(settings.step || 1));
  });
  el.btnMute.addEventListener('click', toggleMute);
  el.btnReconnect.addEventListener('click', function () {
    run('connect', { ip: settings.ip }).catch(function () {});
  });
  el.btnSetup.addEventListener('click', function () {
    Conn.openOptions();
  });
  el.btnOptions.addEventListener('click', function () {
    Conn.openOptions();
  });
  el.btnRefresh.addEventListener('click', function () {
    run('refresh', {})
      .then(function () {
        say('已同步设备状态');
      })
      .catch(function () {});
  });

  // 重启 EchoService 需要二次确认
  el.btnReboot.addEventListener('click', function () {
    if (el.btnReboot.dataset.armed === '1') {
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = null;
      el.btnReboot.dataset.armed = '0';
      el.btnReboot.innerHTML = UI.icon('power') + '重启服务';
      run('reboot', {})
        .then(function () {
          say('已发送重启指令，约 20 秒后恢复');
        })
        .catch(function () {});
      return;
    }
    el.btnReboot.dataset.armed = '1';
    el.btnReboot.innerHTML = UI.icon('power') + '确认重启？';
    confirmTimer = setTimeout(function () {
      confirmTimer = null;
      el.btnReboot.dataset.armed = '0';
      el.btnReboot.innerHTML = UI.icon('power') + '重启服务';
    }, 4000);
  });

  el.btnPlay.addEventListener('click', function () {
    run(device.playState === 1 ? 'pause' : 'play', {}).catch(function () {});
  });
  el.btnNext.addEventListener('click', function () {
    run('next', {}).catch(function () {});
  });
  el.btnPrev.addEventListener('click', function () {
    run('prev', {}).catch(function () {});
  });
  el.btnClose.addEventListener('click', function () {
    // 先关掉自己，保证按钮永远不会“点了没反应”；
    // service worker 可能已经重启过、记不住这个窗口，所以不能只依赖它
    try {
      window.close();
    } catch (e) {
      /* ignore */
    }
    Conn.closePanel().catch(function () {});
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      bump(settings.step || 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      bump(-(settings.step || 1));
    } else if (e.key === 'm' || e.key === 'M') {
      toggleMute();
    } else if (e.key === 'Escape') {
      window.close();
    }
  });

  /* 拖动标题栏 = 移动窗口（Chrome 只在 -moz 场景支持 app-region，这里手写） */
  (function enableWindowDrag() {
    var draggingWin = false;
    var startX = 0;
    var startY = 0;
    var originX = 0;
    var originY = 0;

    el.dragbar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      draggingWin = true;
      startX = e.screenX;
      startY = e.screenY;
      originX = window.screenX;
      originY = window.screenY;
      el.dragbar.setPointerCapture(e.pointerId);
    });

    el.dragbar.addEventListener('pointermove', function (e) {
      if (!draggingWin) return;
      var dx = e.screenX - startX;
      var dy = e.screenY - startY;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      window.moveTo(originX + dx, originY + dy);
    });

    var stop = function (e) {
      if (!draggingWin) return;
      draggingWin = false;
      try {
        el.dragbar.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    };
    el.dragbar.addEventListener('pointerup', stop);
    el.dragbar.addEventListener('pointercancel', stop);
  })();

  Conn.onState(applyState);

  /* ---------------------------------------------------------------- 启动 */

  UI.hydrateIcons(document);
  buildSteps();
  render();
  el.knob.focus();

  Conn.getState()
    .then(function (state) {
      applyState(state);
      if (!state || Date.now() - (state.updatedAt || 0) > C.FRESH_WINDOW) {
        return Conn.act('refresh', {}).catch(function () {});
      }
      return null;
    })
    .catch(function (err) {
      say(err.message, true);
      updateStatus();
    });
})();
