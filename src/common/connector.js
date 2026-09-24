/**
 * 界面侧与 Service Worker 的通信封装。
 * 所有界面（弹窗 / 悬浮面板 / 设置页）共用这一份逻辑，
 * 保证指令只走一条通道、状态只有一个来源。
 */
(function (root) {
  'use strict';

  function call(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      // 必须明显大于 service worker 自己的处理超时（3 秒），
      // 否则界面会先报「无响应」，把后台给出的具体原因盖掉。
      // 重建连接桥这类明确较慢的动作可以单独放宽。
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('扩展后台没有响应，请在扩展页点一次「重新加载」'));
      }, timeoutMs || 8000);

      var clear = function () {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        return true;
      };

      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (!clear()) return;
          var err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || '扩展后台不可用'));
            return;
          }
          if (!res) {
            reject(new Error('扩展后台无响应'));
            return;
          }
          if (!res.ok) {
            reject(new Error(res.error || '操作失败'));
            return;
          }
          resolve(res.result);
        });
      } catch (e) {
        if (clear()) reject(e);
      }
    });
  }

  var Connector = {
    call: call,
    getState: function () {
      return call({ type: 'get_state' });
    },
    act: function (action, payload) {
      return call(Object.assign({ type: 'action', action: action }, payload || {}));
    },
    patchSettings: function (patch) {
      return call({ type: 'settings:patch', patch: patch });
    },
    openPanel: function () {
      return call({ type: 'panel:open' });
    },
    closePanel: function () {
      return call({ type: 'panel:close' });
    },
    openOptions: function () {
      return call({ type: 'options:open' });
    },
    onState: function (handler) {
      var listener = function (msg) {
        if (!msg || msg.target !== 'ui' || msg.type !== 'state') return;
        handler(msg.state);
      };
      chrome.runtime.onMessage.addListener(listener);
      return function () {
        chrome.runtime.onMessage.removeListener(listener);
      };
    },
    onSession: function (handler) {
      var listener = function (msg) {
        if (!msg || msg.target !== 'ui' || msg.type !== 'session') return;
        handler(msg);
      };
      chrome.runtime.onMessage.addListener(listener);
      return function () {
        chrome.runtime.onMessage.removeListener(listener);
      };
    }
  };

  root.R1Connector = Connector;
})(typeof self !== 'undefined' ? self : this);
