/**
 * 共享的图标与交互组件（旋钮、滑杆）。
 * 所有界面共用，保证观感与行为完全一致。
 */
(function (root) {
  'use strict';

  function icon(name) {
    var d = ICONS[name] || ICONS.help;
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
  }

  var ICONS = {
    volume:
      '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" fill="currentColor" stroke="none"/>' +
      '<path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8M18.2 5.9a8.6 8.6 0 0 1 0 12.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    mute:
      '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" fill="currentColor" stroke="none"/>' +
      '<path d="m16 10 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    speaker:
      '<rect x="3" y="2.5" width="18" height="19" rx="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="12" cy="14.5" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="12" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>' +
      '<circle cx="12" cy="6.8" r="1.2" fill="currentColor" stroke="none"/>',
    settings:
      '<circle cx="12" cy="12" r="3.3" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    refresh:
      '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
      '<path d="M18.6 2.6v4h-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    power:
      '<path d="M12 3v8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
      '<path d="M6.6 6.8a7.6 7.6 0 1 0 10.8 0" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    play: '<path d="M7 4.5 19.5 12 7 19.5Z" fill="currentColor" stroke="none"/>',
    pause:
      '<rect x="6.5" y="4.5" width="3.6" height="15" rx="1.2" fill="currentColor" stroke="none"/>' +
      '<rect x="13.9" y="4.5" width="3.6" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
    next: '<path d="M6 5.5 16 12 6 18.5Z" fill="currentColor" stroke="none"/><rect x="16.6" y="5" width="2.6" height="14" rx="1.1" fill="currentColor" stroke="none"/>',
    prev: '<path d="M18 5.5 8 12l10 6.5Z" fill="currentColor" stroke="none"/><rect x="4.8" y="5" width="2.6" height="14" rx="1.1" fill="currentColor" stroke="none"/>',
    note:
      '<path d="M9 18V6.2l9-1.9v11.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<circle cx="6.6" cy="18" r="2.7" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="15.6" cy="15.7" r="2.7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    grip: '<circle cx="9" cy="6" r="1.5" fill="currentColor"/><circle cx="15" cy="6" r="1.5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="9" cy="18" r="1.5" fill="currentColor"/><circle cx="15" cy="18" r="1.5" fill="currentColor"/>',
    close:
      '<path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    link:
      '<path d="M10.6 13.4a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M13.4 10.6a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    unlink:
      '<path d="M10.6 13.4a4 4 0 0 0 5.7 0l1.6-1.6M13.4 10.6a4 4 0 0 0-5.7 0L6.1 12.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="m4 4 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    spark:
      '<path d="M12 3.2 13.9 9l5.9 1.8-5.9 1.8L12 18.4l-1.9-5.8L4.2 10.8 10.1 9Z" fill="currentColor" stroke="none"/>',
    flask:
      '<path d="M10 3.2h4M10.9 3.2v4.3L6.4 16.4A2.6 2.6 0 0 0 8.7 20.2h6.6a2.6 2.6 0 0 0 2.3-3.8l-4.5-8.9V3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M8.2 14.4h7.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    help:
      '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<circle cx="12" cy="16.8" r="1.1" fill="currentColor"/>'
  };

  /** 把页面里 [data-icon] 元素填上对应图标 */
  function hydrateIcons(scope) {
    var list = (scope || document).querySelectorAll('[data-icon]');
    Array.prototype.forEach.call(list, function (el) {
      el.innerHTML = icon(el.getAttribute('data-icon'));
    });
  }

  /** 百分比 -> 圆环 conic-gradient 的进度值 */
  function ringPercent(ratio) {
    var r = Math.max(0, Math.min(1, ratio));
    return (r * 360).toFixed(2) + 'deg';
  }

  /**
   * 把 <input type="range"> 与圆环、数值绑定在一起。
   * 拖动时立刻回调（已节流），同时更新视觉。
   */
  function createSlider(opts) {
    var input = opts.input;
    var onLive = opts.onLive || function () {};
    var onCommit = opts.onCommit || function () {};
    var max = opts.max || 15;
    var value = opts.value || 0;
    var liveTimer = null;
    var pending = null;
    var dragging = false;

    function paint(next) {
      value = next;
      input.max = String(max);
      input.value = String(next);
      var ratio = max > 0 ? next / max : 0;
      input.style.setProperty('--r1-fill', (ratio * 100).toFixed(1) + '%');
      if (opts.onPaint) opts.onPaint(next, max, ratio);
    }

    input.addEventListener('pointerdown', function () {
      dragging = true;
    });
    input.addEventListener('input', function () {
      var next = Number(input.value);
      value = next;
      var ratio = max > 0 ? next / max : 0;
      input.style.setProperty('--r1-fill', (ratio * 100).toFixed(1) + '%');
      if (opts.onPaint) opts.onPaint(next, max, ratio);
      pending = next;
      if (liveTimer) return;
      liveTimer = setTimeout(function () {
        liveTimer = null;
        if (pending !== null) onLive(pending);
        pending = null;
      }, 110);
    });
    // 一次拖动会同时触发 pointerup 和 change，这里做去重，避免下发两条相同指令
    var lastCommit = { value: -1, at: 0 };
    function commitValue(next) {
      var v = Math.max(0, Math.min(max, Number(next) || 0));
      var now = Date.now();
      if (v === lastCommit.value && now - lastCommit.at < 400) return;
      lastCommit.value = v;
      lastCommit.at = now;
      onCommit(v);
    }

    var finish = function () {
      if (!dragging) return;
      dragging = false;
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
      }
      pending = null;
      commitValue(input.value);
    };
    input.addEventListener('pointerup', finish);
    input.addEventListener('pointercancel', finish);
    input.addEventListener('change', function () {
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
      }
      pending = null;
      commitValue(input.value);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1;
        var next = Math.max(0, Math.min(max, value + delta));
        paint(next);
        onLive(next);
      }
    });

    return {
      paint: paint,
      setMax: function (nextMax) {
        max = nextMax;
        input.max = String(nextMax);
        paint(Math.min(value, nextMax));
      },
      get value() {
        return value;
      },
      get max() {
        return max;
      },
      get dragging() {
        return dragging;
      }
    };
  }

  /**
   * 圆形旋钮：拖动改音量，滚轮微调，双击静音。
   */
  function createKnob(opts) {
    var el = opts.el;
    var fill = el.querySelector('.knob__fill');
    var num = el.querySelector('.knob__num');
    var sub = el.querySelector('.knob__sub');
    var onLive = opts.onLive || function () {};
    var onCommit = opts.onCommit || function () {};
    var onDouble = opts.onDouble || function () {};
    var max = opts.max || 15;
    var value = opts.value || 0;
    var dragging = false;
    var moved = false;
    var startY = 0;
    var startValue = 0;
    var commitTimer = null;
    var pending = null;

    function paint(next) {
      value = next;
      var ratio = max > 0 ? next / max : 0;
      fill.style.background =
        'conic-gradient(from -90deg, #ff5f56 0%, #ff9a45 52%, #ffd166 ' +
        ringPercent(ratio) +
        ', rgba(255,255,255,0.06) ' +
        ringPercent(ratio) +
        ')';
      num.textContent = String(next);
      sub.textContent = '共 ' + max + ' 级 · ' + Math.round(ratio * 100) + '%';
      el.classList.toggle('is-muted', next === 0);
    }

    function commit(next) {
      if (commitTimer) clearTimeout(commitTimer);
      pending = next;
      commitTimer = setTimeout(function () {
        commitTimer = null;
        if (pending === null) return;
        var v = pending;
        pending = null;
        onCommit(v);
      }, 130);
    }

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startValue = value;
      el.classList.add('dragging');
      document.body.classList.add('r1-dragging');
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = startY - e.clientY;
      if (Math.abs(dy) > 2) moved = true;
      var span = 150; // 拖动 150px 覆盖整个量程
      var next = Math.round(startValue + (dy / span) * max);
      next = Math.max(0, Math.min(max, next));
      if (next === value) return;
      paint(next);
      onLive(next);
      commit(next);
    });

    function stop(e) {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      document.body.classList.remove('r1-dragging');
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (!moved) {
        // 单击 = 轻推一级（相当于点按旋钮的 1/8 量程）
        var step = Math.max(1, Math.round(max / 8));
        var next = Math.min(max, value + step);
        if (value >= max) next = 0;
        paint(next);
        onCommit(next);
        return;
      }
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      var final = pending === null ? value : pending;
      pending = null;
      onCommit(final);
    }
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);

    el.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var dir = e.deltaY < 0 ? 1 : -1;
        var next = Math.max(0, Math.min(max, value + dir));
        if (next === value) return;
        paint(next);
        onLive(next);
        commit(next);
      },
      { passive: false }
    );

    el.addEventListener('dblclick', function (e) {
      e.preventDefault();
      onDouble();
    });

    el.addEventListener('keydown', function (e) {
      // 旋钮是可聚焦的，方向键必须在这里被消费掉，
      // 否则页面级快捷键会再处理一次，一次按键变成两次调整
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        var up = Math.min(max, value + 1);
        paint(up);
        onCommit(up);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        var down = Math.max(0, value - 1);
        paint(down);
        onCommit(down);
      }
    });

    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', '音箱音量');
    paint(value);

    return {
      paint: paint,
      setMax: function (nextMax) {
        max = nextMax;
        el.setAttribute('aria-valuemax', String(nextMax));
        paint(Math.min(value, nextMax));
      },
      get value() {
        return value;
      },
      get max() {
        return max;
      },
      get dragging() {
        return dragging;
      }
    };
  }

  /** 轻量 toast */
  function createToast(el) {
    var timer = null;
    return function (text, isError) {
      if (!el) return;
      el.textContent = String(text || '');
      el.classList.toggle('is-error', !!isError);
      el.classList.add('is-on');
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        el.classList.remove('is-on');
      }, 1900);
    };
  }

  /**
   * 指令去重：短时间内重复下发同一个音量会被忽略。
   * （旋钮的 pointerup 与 change、滑杆的 pointerup 与 change 都可能重复触发）
   */
  function createDeduper(windowMs) {
    var span = windowMs || 350;
    var last = { value: null, at: 0 };
    return function (value) {
      var now = Date.now();
      if (last.value === value && now - last.at < span) return false;
      last.value = value;
      last.at = now;
      return true;
    };
  }

  root.R1UI = {
    ICONS: ICONS,
    icon: icon,
    hydrateIcons: hydrateIcons,
    ringPercent: ringPercent,
    createSlider: createSlider,
    createKnob: createKnob,
    createToast: createToast,
    createDeduper: createDeduper
  };
})(typeof self !== 'undefined' ? self : this);
