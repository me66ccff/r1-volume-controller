/**
 * 网页悬浮球：默认关闭，开启后会在任意网页右下角显示一个实时音量球。
 * 点一下弹出迷你 HUD（滑杆 + 加减 + 静音），按住可拖动，双击回到默认位置。
 * 所有指令依旧交给 Service Worker，和弹窗、悬浮面板共用同一条连接。
 */
(function () {
  'use strict';

  if (window.top !== window) return;
  if (window.__r1OrbLoaded) return;
  window.__r1OrbLoaded = true;

  var C = self.R1;
  if (!C) return;

  var ORB_SIZE = 52;
  var POS_KEY = 'orbPos';
  var root = null;
  var orb = null;
  var canvas = null;
  var numEl = null;
  var hud = null;
  var hudNum = null;
  var hudState = null;
  var hudSlider = null;
  var hudTitle = null;
  var hudMute = null;
  var hudMinus = null;
  var hudPlus = null;
  var settings = Object.assign({}, C.DEFAULT_SETTINGS);
  var status = 'disabled';
  var device = C.emptyDevice();
  var position = null;
  var orphaned = false;
  var hudOpen = false;
  var dragState = null;
  var sendTimer = null;
  var sendPending = null;
  var lastSendAt = 0;

  /* ---------------------------------------------------------------- 通信 */

  function send(message, cb) {
    if (orphaned) return;
    try {
      chrome.runtime.sendMessage(message, function (res) {
        if (chrome.runtime.lastError) {
          if (/context invalidated|Receiving end does not exist/i.test(chrome.runtime.lastError.message || '')) {
            orphaned = true;
            destroy();
          }
          if (cb) cb(null);
          return;
        }
        if (cb) cb(res);
      });
    } catch (e) {
      orphaned = true;
      destroy();
    }
  }

  function act(action, payload) {
    send(Object.assign({ target: 'background', type: 'action', action: action }, payload || {}));
  }

  /* ---------------------------------------------------------------- 绘制 */

  function css(prop, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(prop);
      return v && v.trim() ? v.trim() : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function drawRing(ratio, online, muted) {
    if (!canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = ORB_SIZE;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    var pad = 3;
    var center = size / 2;
    var radius = center - pad;
    var start = -Math.PI / 2;
    var end = start + Math.PI * 2 * Math.max(0, Math.min(1, ratio));

    ctx.lineWidth = 4;
    ctx.lineCap = 'round';

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (!online) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(center, center, radius, start, start + Math.PI * 0.5);
      ctx.stroke();
      return;
    }

    if (muted) {
      ctx.strokeStyle = 'rgba(150,160,178,0.55)';
      ctx.beginPath();
      ctx.arc(center, center, radius, start, end);
      ctx.stroke();
      return;
    }

    var grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#ff5f56');
    grad.addColorStop(0.55, '#ff9a45');
    grad.addColorStop(1, '#ffd166');
    ctx.strokeStyle = grad;
    ctx.shadowColor = 'rgba(255,120,60,0.55)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(center, center, radius, start, end);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render() {
    if (!orb) return;
    var online = status === 'online';
    var vol = device.vol;
    var max = device.max || C.DEFAULT_MAX_VOL;
    var muted = vol === 0;
    numEl.textContent = online ? String(vol) : '--';
    orb.classList.toggle('r1-orb--muted', muted);
    orb.classList.toggle('r1-orb--offline', !online);
    orb.title =
      (device.hostname || settings.ip || 'R1 音箱') +
      '：' +
      (online ? '音量 ' + vol + '/' + max + '（点击调节）' : '未连接（点击重连）');
    drawRing(online ? vol / max : 0, online, muted);

    if (hudOpen) {
      hudNum.textContent = online ? String(vol) : '--';
      hudSlider.max = String(max);
      hudSlider.value = String(vol);
      hudSlider.disabled = !online;
      hudSlider.style.setProperty('--r1-fill', ((online ? vol / max : 0) * 100).toFixed(1) + '%');
      hudMute.textContent = muted ? '取消静音' : '静音';
      hudTitle.textContent = device.hostname || settings.ip || 'R1 音箱';
      var bits = [];
      if (!settings.ip) bits.push('未配置地址');
      else if (online) bits.push('已连接 · ' + C.playStateText(device.playState));
      else if (status === 'connecting') bits.push('连接中…');
      else bits.push('未连接');
      if (online && device.track && device.track.title) bits.push(device.track.title);
      hudState.textContent = bits.join(' · ');
      hudMinus.disabled = !online;
      hudPlus.disabled = !online;
      hudMute.disabled = !online;
    }
  }

  /* ---------------------------------------------------------------- HUD */

  function positionHud() {
    if (!hud || !orb) return;
    var rect = orb.getBoundingClientRect();
    var w = 268;
    var h = hud.offsetHeight || 168;
    var gap = 10;
    var left = rect.left + rect.width / 2 - w / 2;
    var top = rect.top - h - gap;
    if (top < 8) top = rect.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    hud.style.left = Math.round(left) + 'px';
    hud.style.top = Math.round(top) + 'px';
  }

  function openHud() {
    if (!hud) return;
    hudOpen = true;
    hud.classList.add('r1-open');
    render();
    positionHud();
    send({ target: 'background', type: 'action', action: 'refresh' });
  }

  function closeHud() {
    if (!hud) return;
    hudOpen = false;
    hud.classList.remove('r1-open');
  }

  function commitVolume(vol) {
    var now = Date.now();
    sendPending = vol;
    var run = function () {
      sendTimer = null;
      var v = sendPending;
      sendPending = null;
      if (v === null) return;
      lastSendAt = Date.now();
      act('set_vol', { vol: v });
    };
    if (now - lastSendAt > 220) {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = null;
      run();
    } else if (!sendTimer) {
      sendTimer = setTimeout(run, 200);
    }
  }

  /* ---------------------------------------------------------------- 构建 DOM */

  function build() {
    root = document.createElement('div');
    root.id = 'r1-orb-root';

    orb = document.createElement('div');
    orb.id = 'r1-orb';
    canvas = document.createElement('canvas');
    numEl = document.createElement('span');
    numEl.className = 'r1-orb__num';
    numEl.textContent = '--';
    var dot = document.createElement('span');
    dot.className = 'r1-orb__dot';
    orb.appendChild(canvas);
    orb.appendChild(numEl);
    orb.appendChild(dot);

    hud = document.createElement('div');
    hud.id = 'r1-hud';
    hud.innerHTML =
      '<div class="r1-hud__head">' +
      '<span class="r1-hud__title">R1 音箱</span>' +
      '<span class="r1-hud__state">—</span>' +
      '<button class="r1-hud__close" type="button" title="收起">✕</button>' +
      '</div>' +
      '<div class="r1-hud__vol"><span class="r1-hud__num">--</span><span class="r1-hud__max"></span></div>' +
      '<input type="range" min="0" max="15" step="1" value="0" />' +
      '<div class="r1-hud__row">' +
      '<button class="r1-hud__btn" type="button" data-act="down">−</button>' +
      '<button class="r1-hud__btn r1-hud__btn--accent" type="button" data-act="mute">静音</button>' +
      '<button class="r1-hud__btn" type="button" data-act="up">+</button>' +
      '</div>' +
      '<div class="r1-hud__foot"><span class="r1-hud__tip">拖动小球可移动位置</span>' +
      '<button class="r1-hud__link" type="button" data-act="panel">打开完整面板</button></div>';

    root.appendChild(orb);
    root.appendChild(hud);
    (document.body || document.documentElement).appendChild(root);

    hudNum = hud.querySelector('.r1-hud__num');
    hudState = hud.querySelector('.r1-hud__state');
    hudSlider = hud.querySelector('input[type="range"]');
    hudTitle = hud.querySelector('.r1-hud__title');
    hudMute = hud.querySelector('[data-act="mute"]');
    hudMinus = hud.querySelector('[data-act="down"]');
    hudPlus = hud.querySelector('[data-act="up"]');

    hud.querySelector('.r1-hud__close').addEventListener('click', closeHud);
    hud.querySelector('[data-act="panel"]').addEventListener('click', function () {
      act('open_panel');
      closeHud();
    });    hudMinus.addEventListener('click', function () {
      act('vol_down', { step: settings.step || 1 });
    });
    hudPlus.addEventListener('click', function () {
      act('vol_up', { step: settings.step || 1 });
    });
    hudMute.addEventListener('click', function () {
      act('mute_toggle');
    });
    hudSlider.addEventListener('input', function () {
      var v = Number(hudSlider.value);
      var max = Number(hudSlider.max) || C.DEFAULT_MAX_VOL;
      hudNum.textContent = String(v);
      hudSlider.style.setProperty('--r1-fill', ((v / max) * 100).toFixed(1) + '%');
      drawRing(v / max, true, v === 0);
      numEl.textContent = String(v);
      commitVolume(v);
    });

    orb.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        orbX: orb.offsetLeft,
        orbY: orb.offsetTop,
        moved: false,
        pointerId: e.pointerId
      };
      orb.setPointerCapture(e.pointerId);
      orb.classList.add('r1-dragging');
    });

    orb.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      dragState.moved = true;
      position = clampPosition(dragState.orbX + dx, dragState.orbY + dy);
      applyPosition();
    });

    function endDrag(e) {
      if (!dragState) return;
      var moved = dragState.moved;
      dragState = null;
      orb.classList.remove('r1-dragging');
      try {
        orb.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (!moved) {
        if (hudOpen) closeHud();
        else openHud();
        return;
      }
      if (position) {
        try {
          chrome.storage.local.set({ [POS_KEY]: position });
        } catch (err) {
          /* ignore */
        }
      }
    }
    orb.addEventListener('pointerup', endDrag);
    orb.addEventListener('pointercancel', endDrag);

    orb.addEventListener('dblclick', function (e) {
      e.preventDefault();
      position = null;
      try {
        chrome.storage.local.remove(POS_KEY);
      } catch (err) {
        /* ignore */
      }
      applyPosition();
    });

    window.addEventListener('resize', function () {
      position = position ? clampPosition(position.x, position.y) : null;
      applyPosition();
      if (hudOpen) positionHud();
    });
    window.addEventListener(
      'scroll',
      function () {
        if (hudOpen) positionHud();
      },
      true
    );
    document.addEventListener('pointerdown', function (e) {
      if (!hudOpen) return;
      if (root && root.contains(e.target)) return;
      closeHud();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && hudOpen) closeHud();
    });

    applyPosition();
    render();
  }

  function clampPosition(x, y) {
    var maxX = Math.max(4, window.innerWidth - ORB_SIZE - 4);
    var maxY = Math.max(4, window.innerHeight - ORB_SIZE - 4);
    return { x: Math.max(4, Math.min(maxX, x)), y: Math.max(4, Math.min(maxY, y)) };
  }

  function applyPosition() {
    if (!orb) return;
    if (position) {
      orb.style.left = position.x + 'px';
      orb.style.top = position.y + 'px';
      orb.style.right = 'auto';
      orb.style.bottom = 'auto';
    } else {
      orb.style.left = 'auto';
      orb.style.top = 'auto';
      orb.style.right = '18px';
      orb.style.bottom = '18px';
    }
    if (hudOpen) positionHud();
  }

  function destroy() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    orb = null;
    hud = null;
  }

  /* ---------------------------------------------------------------- 启动 */

  function applySettings(next) {
    var wasOn = !!settings.showOrb;
    settings = Object.assign({}, C.DEFAULT_SETTINGS, next || {});
    if (settings.showOrb && !root) build();
    if (!settings.showOrb && root) destroy();
    if (root) render();
    return wasOn;
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'content') return;
    if (msg.type === 'state') {
      status = msg.state.status;
      device = Object.assign(C.emptyDevice(), msg.state.device || {});
      if (msg.state.settings) settings = Object.assign({}, C.DEFAULT_SETTINGS, msg.state.settings);
      if (settings.showOrb && !root) build();
      if (!settings.showOrb && root) destroy();
      if (root) render();
    } else if (msg.type === 'panel-open') {
      openHud();
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.settings) applySettings(changes.settings.newValue);
    if (changes[POS_KEY]) {
      position = changes[POS_KEY].newValue || null;
      applyPosition();
    }
  });

  // 通过一次状态请求完成首次渲染（同时校验扩展上下文是否仍然有效）
  chrome.storage.local.get([C.SETTINGS_KEY, POS_KEY]).then(function (got) {
    if (got && got[POS_KEY]) position = got[POS_KEY];
    var on = applySettings(got && got[C.SETTINGS_KEY]);
    if (!settings.showOrb && !on) return;
    send({ target: 'background', type: 'get_state' }, function (res) {
      if (res && res.result) {
        status = res.result.status;
        device = Object.assign(C.emptyDevice(), res.result.device || {});
        if (res.result.settings) settings = Object.assign({}, C.DEFAULT_SETTINGS, res.result.settings);
        if (root) render();
      }
    });
  });
})();
