/**
 * 发布前自检：语法 + 引用完整性 + manifest 合法性。
 * 用法: node tools/check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  });
  return out;
}

const files = walk(ROOT);
const byRel = new Set(files.map(rel));

/** service worker 允许顶层 await，包一层 async 作用域后再校验语法 */
function checkJs(code, filename) {
  try {
    new vm.Script(code, { filename });
    return null;
  } catch (err) {
    if (/await is only valid/i.test(err.message)) {
      // 包一层 async 后仍然报错，说明确实存在非 async 作用域里的 await
      return err.message;
    }
    return err.message;
  }
}

/** 逐行定位“非 async 作用域里的 await”（经典 service worker 不允许顶层 await） */
function findStrayAwait(code, filename) {
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const probe = lines.slice(0, i + 1).join('\n') + '\n/*EOF*/';
    try {
      new vm.Script('(async () => {\n' + probe + '\n})', { filename });
    } catch (err) {
      if (/await is only valid/i.test(err.message)) return { line: i + 1, text: lines[i].trim() };
    }
  }
  return null;
}

/** service worker 必须是经典脚本：不能有顶层 await */
function checkClassicScript(code, filename) {
  try {
    new vm.Script(code, { filename });
    return null;
  } catch (err) {
    if (/await is only valid/i.test(err.message)) {
      const stray = findStrayAwait(code, filename);
      const where = stray ? `第 ${stray.line} 行: ${stray.text}` : '未知位置';
      return `经典脚本里不能使用顶层 await（${where}）`;
    }
    return `语法错误: ${err.message}`;
  }
}

/* ---------------------------------------------------------------- 1. JS 语法 */

files
  .filter((f) => f.endsWith('.js'))
  .forEach((file) => {
    const code = fs.readFileSync(file, 'utf8');
    const isClassicWorker = /importScripts\s*\(/.test(code);
    const message = isClassicWorker ? checkClassicScript(code, file) : checkJs(code, file);
    if (message) problems.push(`${rel(file)}: ${message}`);
  });

/* ---------------------------------------------------------------- 2. HTML 内联脚本 + 资源引用 */

const htmlFiles = files.filter((f) => f.endsWith('.html'));

function resolveRef(fromFile, ref) {
  return path.resolve(path.dirname(fromFile), ref.split('?')[0].split('#')[0]);
}

htmlFiles.forEach((file) => {
  const html = fs.readFileSync(file, 'utf8');

  // 内联 <script> 语法
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  inline.forEach((m, i) => {
    if (!m[1].trim()) return;
    const message = checkJs(m[1], `${rel(file)}#inline${i}`);
    if (message) problems.push(`HTML 内联脚本语法错误 ${rel(file)}: ${message}`);
  });

  // 外链资源是否存在
  const refs = [
    ...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<link[^>]*\bhref=["']([^"']+)["']/gi)
  ];
  refs.forEach((m) => {
    const ref = m[1];
    if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) return;
    const target = resolveRef(file, ref);
    if (!fs.existsSync(target)) problems.push(`缺少资源 ${rel(file)} -> ${ref}`);
  });

  // 每个 HTML 引用的元素 id 是否都被 JS 使用（仅记录，不报错）
  const idList = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
  const ids = new Set(idList);

  // 重复 id 会让 getElementById 结果不确定，直接报错
  const dupes = idList.filter((id, i) => idList.indexOf(id) !== i);
  if (dupes.length) problems.push(`${rel(file)} 存在重复 id: ${[...new Set(dupes)].join(', ')}`);

  notes.push(`${rel(file)}: ${ids.size} 个 id`);
});

/**
 * HTML 与配套脚本的 id 双向核对。
 * 这一条是真踩过的坑：删掉 HTML 里的按钮却忘了删 JS 里的引用，
 * `$('btnPlay')` 返回 null，紧接着的 `.disabled = ...` 直接抛 TypeError，
 * 整个界面的渲染会在中途断掉。
 */
[
  ['src/popup/popup.js', 'src/popup/popup.html'],
  ['src/panel/panel.js', 'src/panel/panel.html'],
  ['src/options/options.js', 'src/options/options.html']
].forEach(([jsRel, htmlRel]) => {
  const jsPath = path.join(ROOT, jsRel);
  const htmlPath = path.join(ROOT, htmlRel);
  if (!fs.existsSync(jsPath) || !fs.existsSync(htmlPath)) return;

  const code = fs.readFileSync(jsPath, 'utf8');
  const ids = new Set(
    [...fs.readFileSync(htmlPath, 'utf8').matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1])
  );

  const used = new Set();
  [...code.matchAll(/\$\('([^']+)'\)/g)].forEach((m) => used.add(m[1]));
  [...code.matchAll(/getElementById\('([^']+)'\)/g)].forEach((m) => used.add(m[1]));

  const missing = [...used].filter((id) => !ids.has(id));
  if (missing.length) {
    problems.push(`${jsRel} 引用了 ${htmlRel} 中不存在的 id: ${missing.join(', ')}（会取到 null 并抛错）`);
  }
});

/* ---------------------------------------------------------------- 3. manifest */

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
} catch (err) {
  problems.push(`manifest.json 解析失败: ${err.message}`);
}

if (manifest) {
  const mustExist = [];
  mustExist.push(manifest.background && manifest.background.service_worker);
  mustExist.push(manifest.action && manifest.action.default_popup);
  mustExist.push(manifest.options_page);
  if (manifest.action && manifest.action.default_icon) mustExist.push(...Object.values(manifest.action.default_icon));
  if (manifest.icons) mustExist.push(...Object.values(manifest.icons));
  (manifest.content_scripts || []).forEach((cs) => {
    mustExist.push(...(cs.js || []), ...(cs.css || []));
  });
  if (manifest.default_locale) mustExist.push(`_locales/${manifest.default_locale}/messages.json`);

  mustExist.filter(Boolean).forEach((p) => {
    if (!fs.existsSync(path.join(ROOT, p))) problems.push(`manifest 引用了不存在的文件: ${p}`);
  });

  if (manifest.manifest_version !== 3) problems.push('manifest_version 必须是 3');
  if (!manifest.permissions || !manifest.permissions.includes('offscreen')) {
    problems.push('需要 offscreen 权限');
  }
  if (!manifest.permissions || !manifest.permissions.includes('alarms')) {
    problems.push('需要 alarms 权限（保活）');
  }
  const sw = manifest.background && manifest.background.service_worker;
  if (sw) {
    const code = fs.readFileSync(path.join(ROOT, sw), 'utf8');
    const imports = [...code.matchAll(/importScripts\(([^)]*)\)/g)];
    imports.forEach((m) => {
      [...m[1].matchAll(/["']([^"']+)["']/g)].forEach((mm) => {
        const target = path.resolve(path.dirname(path.join(ROOT, sw)), mm[1]);
        if (!fs.existsSync(target)) problems.push(`importScripts 找不到文件: ${mm[1]}`);
      });
    });
  }
}

/* ---------------------------------------------------------------- 4. 关键约定 */

const constants = fs.readFileSync(path.join(ROOT, 'src/common/constants.js'), 'utf8');
if (!/set_vol/.test(constants) === false) notes.push('constants.js 含 set_vol 关键字');
['get_info', 'max_vol', 'set_vol'].forEach((type) => {
  const used = files.some((f) => f.endsWith('.js') && fs.readFileSync(f, 'utf8').includes(`'${type}'`));
  if (!used) problems.push(`协议关键字 ${type} 没有被使用`);
});

/* ---------------------------------------------------------------- 5. [hidden] 必须真的能隐藏 */

/**
 * 这是一个真实踩过的坑：.device{display:flex} 这类类选择器优先级高于浏览器默认的
 * [hidden]{display:none}，导致 JS 里 el.hidden = true 完全失效，卡片一直显示。
 * 所以共享样式里必须有一条带 !important 的 [hidden] 规则。
 */
const sharedCss = fs
  .readFileSync(path.join(ROOT, 'src/common/ui.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ''); // 先去掉注释，避免匹配到注释里举例的规则
const hiddenRule = sharedCss.match(/\[hidden\][^{]*\{([^}]*)\}/);
if (!hiddenRule) {
  problems.push('src/common/ui.css 缺少 [hidden] 规则：JS 里设置 el.hidden 将不会生效');
} else if (!/display\s*:\s*none/.test(hiddenRule[1]) || !/!important/.test(hiddenRule[1])) {
  problems.push('[hidden] 规则必须是 display:none !important，否则会被 display:flex 之类的类选择器覆盖');
}

const jsSources = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8'));
const hidesAtRuntime = jsSources.some((code) => /\.hidden\s*=/.test(code));
if (hidesAtRuntime && !hiddenRule) problems.push('有 JS 依赖 el.hidden，但样式里没有对应规则');

/* ---------------------------------------------------------------- 输出 */

console.log(`扫描 ${files.length} 个文件。`);
notes.forEach((n) => console.log('  · ' + n));
if (problems.length) {
  console.log('\n发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log('\n✓ 自检通过：语法、资源引用、manifest 均正常。');
