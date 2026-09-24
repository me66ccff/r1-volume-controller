/**
 * UI 组件逻辑测试：指令去重（防止一次拖动/一次按键下发两条指令）。
 * 用最小 DOM 打桩加载 ui.js，不需要浏览器。
 * 用法: node tools/test-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI_PATH = path.join(__dirname, '..', 'src', 'common', 'ui.js');

/* ---------------------------------------------------------------- 最小 DOM 打桩 */

function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    attributes: {},
    value: '0',
    max: '15',
    offsetHeight: 100,
    tabIndex: 0,
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
    },
    querySelector() {
      return makeElement('div');
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event) {
      (listeners.get(type) || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, event)));
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 52, bottom: 52, width: 52, height: 52 };
    },
    get listenerCount() {
      return [...listeners.values()].reduce((n, l) => n + l.length, 0);
    }
  };
  return el;
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  JSON,
  document: {
    body: makeElement('body'),
    documentElement: makeElement('html'),
    querySelectorAll: () => []
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' })
};
sandbox.self = sandbox;
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(UI_PATH, 'utf8'), sandbox, { filename: UI_PATH });
const UI = sandbox.R1UI;

let passed = 0;
const failures = [];

function ok(value, label) {
  if (value) passed++;
  else failures.push(label);
}

/* ---------------------------------------------------------------- 去重器 */

ok(typeof UI.createDeduper === 'function', 'createDeduper 已导出');

const dedupe = UI.createDeduper(350);
ok(dedupe(7) === true, '首次下发不被拦截');
ok(dedupe(7) === false, '350ms 内相同数值被拦截');
ok(dedupe(8) === true, '不同数值放行');
ok(dedupe(7) === true, '数值变化后再回到原值应放行');

/* ---------------------------------------------------------------- 滑杆：一次拖动只提交一次 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testSlider() {
  const input = makeElement('input');
  const commits = [];
  const lives = [];
  const slider = UI.createSlider({
    input,
    max: 15,
    value: 3,
    onLive: (v) => lives.push(v),
    onCommit: (v) => commits.push(v)
  });

  // 模拟真实浏览器事件顺序：pointerdown -> input(多次) -> pointerup -> change
  input.dispatch('pointerdown', { button: 0 });
  input.value = '5';
  input.dispatch('input');
  input.value = '9';
  input.dispatch('input');
  input.value = '12';
  input.dispatch('input');
  await sleep(160); // 实时回调是 110ms 节流的
  input.dispatch('pointerup', { pointerId: 1 });
  input.value = '12';
  input.dispatch('change'); // 浏览器在拖动结束后仍会派发 change

  ok(commits.length === 1, `一次拖动只提交一次（实际 ${commits.length} 次：${commits.join(',')}）`);
  ok(commits[0] === 12, `提交的是最终值 12（实际 ${commits[0]}）`);
  ok(lives.length === 1 && lives[0] === 12, `拖动过程中有实时回调（实际 ${lives.length} 次：${lives.join(',')}）`);

  // 键盘调整：滑杆自己消费方向键（真实浏览器会先把 range 值 +1 再派发 keydown）
  commits.length = 0;
  lives.length = 0;
  input.value = '13';
  input.dispatch('keydown', { key: 'ArrowUp' });
  ok(slider.value === 13, `方向键 +1（实际 ${slider.value}）`);
  ok(lives.length === 1 && lives[0] === 13, `方向键只触发一次实时回调（实际 ${lives.length} 次）`);
  ok(commits.length === 0, '仍处于去重窗口内，不再重复提交同一个值');

  // 超过去重窗口后，同一个值才允许重新提交
  await sleep(400);
  input.dispatch('change');
  ok(commits.length === 1, '超过去重窗口后同一个值允许再次提交');
  ok(commits[0] === 13, `提交的值正确（实际 ${commits[0]}）`);
}

/* ---------------------------------------------------------------- 旋钮：方向键消费事件 */

function testKnob() {
  const knobEl = makeElement('div');
  const fill = makeElement('div');
  const num = makeElement('div');
  const sub = makeElement('div');
  knobEl.querySelector = (sel) => (sel.includes('fill') ? fill : sel.includes('num') ? num : sub);

  const commits = [];
  const knob = UI.createKnob({
    el: knobEl,
    max: 15,
    value: 5,
    onCommit: (v) => commits.push(v)
  });

  let propagated = 0;
  let prevented = 0;
  knobEl.dispatch('keydown', {
    key: 'ArrowUp',
    preventDefault: () => prevented++,
    stopPropagation: () => propagated++
  });
  ok(commits.length === 1, `旋钮方向键只提交一次（实际 ${commits.length} 次）`);
  ok(propagated === 1, `旋钮方向键调用 stopPropagation，避免页面级快捷键重复处理（实际 ${propagated}）`);
  ok(prevented === 1, '旋钮方向键阻止了默认滚动');
  ok(knob.value === 6, `旋钮方向键 +1（实际 ${knob.value}）`);

  commits.length = 0;
  knobEl.dispatch('keydown', { key: 'ArrowDown' });
  ok(commits.length === 1 && knob.value === 5, '旋钮方向键 -1 且只提交一次');
}

/* ---------------------------------------------------------------- 结果 */

(async function main() {
  await testSlider();
  testKnob();

  console.log(`UI 组件测试：${passed} 项通过`);
  if (failures.length) {
    console.log(`\n${failures.length} 项失败：`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✓ 全部通过');
})();
