/**
 * 工具栏弹窗：完整的音量控制面板（旋钮 + 滑杆 + 显示 + 预设 + 播放控制）。
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
    knobSub: $('knobSub'),
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
    btnRefresh2: $('btnRefresh2'),
    btnOptions: $('btnOptions'),
    btnPanel: $('btnPanel'),
    btnPanel2: $('btnPanel2')
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

  function say(text, isError) {
    toast(text, isError);
  }

  /* ---------------------------------------------------------------- 渲染 */

  function updateStatus() {
    var cls = 'dot';
    var text = '';
    if (!settings.ip) {
      text = '未配置音箱地址';
    } else if (status === 'online') {
      cls += ' dot--online';
      text = '已连接 · ' + (device.host || settings.ip);
    } else if (status === 'connecting') {
      cls += ' dot--connecting';
      text = '正在连接 ' + (device.host || settings.ip) + ' …';
    } else if (status === 'offline') {
      cls += ' dot--offline';
      text = '连接断开 · 自动重连中';
    } else {
      text = '已断开';
    }
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

    el.knobNum.style.opacity = device.vol === null ? '0.45' : '1';
    [el.slider, el.btnUp, el.btnDown, el.btnMute].forEach(function (node) {
      node.disabled = !online;
    });
    el.btnReconnect.disabled = false;
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
    for (var i = 0; i < list.length; i++) {
      if (list[i] === vol) return vol;
    }
    for (var j = 0; j < list.length; j++) {
      if (Math.abs(list[j] - vol) <= 1) return list[j];
    }
    return -1;
  }

  function presetList(max) {
    var set = [0, 3, 5, 8, 10, 12, max];
    var seen = {};
    return set
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
      btn.title = v === 0 ? '静音' : '音量 ' + v;
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
      btn.title = '每次增减 ' + step + ' 级';
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

  /** 播放控制已从弹窗移除（悬浮面板里保留），这里只保留音量相关渲染 */
  function render() {
    buildPresets(device.max);
    updateStatus();
    dragging = knob.dragging || slider.dragging;
    if (!dragging) paintVolume(device.vol, device.max);
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
          pending -= 1;
          if (pending <= 0) {
            pending = 0;
            el.spin.classList.remove('is-on');
          }
          return res;
        },
        function (err) {
          pending -= 1;
          if (pending <= 0) {
            pending = 0;
            el.spin.classList.remove('is-on');
          }
          throw err;
        }
      );
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
  var refresh = function () {
    el.spin.classList.add('is-on');
    run('refresh', {})
      .then(function () {
        say('已同步设备状态');
      })
      .catch(function () {});
  };
  el.btnRefresh.addEventListener('click', refresh);
  el.btnRefresh2.addEventListener('click', refresh);
  el.btnSetup.addEventListener('click', function () {
    Conn.openOptions();
    window.close();
  });
  el.btnOptions.addEventListener('click', function () {
    Conn.openOptions();
    window.close();
  });
  var openPanel = function () {
    Conn.openPanel()
      .then(function () {
        window.close();
      })
      .catch(function (err) {
        say(err.message, true);
      });
  };
  el.btnPanel.addEventListener('click', openPanel);
  el.btnPanel2.addEventListener('click', openPanel);

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
    }
  });

  Conn.onState(applyState);

  /* ---------------------------------------------------------------- 启动 */

  UI.hydrateIcons(document);
  buildSteps();
  render();

  Conn.getState()
    .then(function (state) {
      applyState(state);
      if (!state || Date.now() - (state.updatedAt || 0) > C.FRESH_WINDOW) {
        return Conn.act('refresh', {}).catch(function () {});
      }
      return null;
    })
    .catch(function (err) {
      // 后台不通时给出可操作的提示，而不是让界面停在「等待连接」
      say(err.message, true);
      el.dot.className = 'dot dot--offline';
      el.statusText.textContent = '扩展后台未响应';
      el.cardUnset.hidden = true;
      el.cardOffline.hidden = false;
      el.offlineTitle.textContent = '扩展后台没有响应';
      el.offlineDesc.textContent = '在 chrome://extensions 点一次「重新加载」即可恢复';
    });
})();
