/**
 * 故障注入测试：连接桥出各种毛病时，界面必须始终能得到明确答复。
 *
 * 覆盖的真实现象：
 *   1. 连接桥活着但装死（不回包）-> 界面不能干等到超时
 *   2. 装死的桥被回收后 -> 必须自动恢复
 *   3. 后台诊断接口在桥装死时也必须可用
 *   4. 桥被创建了但脚本没跑起来 -> 后台不能谎报「连接桥可用」
 *   5. 这种桥被回收后 -> 必须自动恢复
 *   6. storage 读不出来 -> 界面依然能拿到答复
 *
 * 用法: node tools/test-faults.js
 */
'use strict';

const { createHarness, sleep } = require('./harness');

let passed = 0;
const failures = [];

function ok(value, label) {
  if (value) passed++;
  else failures.push(label);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n    期望 ${e}\n    实际 ${a}`);
}

async function waitFor(harness, predicate, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  let last = null;
  while (Date.now() < deadline) {
    const res = await harness.sendToWorker({ type: 'get_state' }, 12000);
    last = res && res.result ? res.result : null;
    if (last && predicate(last)) return last;
    await sleep(60);
  }
  failures.push(`${label}（超时，最后状态：${JSON.stringify(last && { status: last.status })}）`);
  return last;
}

/** 让某个上下文的监听器既不回包也不报错（模拟卡死的连接桥） */
function muteContext(context) {
  context.messageEvent.listeners.length = 0;
}

async function run() {
  /* ---------------------------------------------------------------- 1. 连接桥卡死不回包 */

  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker();
    await waitFor(h, (s) => s.status === 'online', '先正常连上');

    // 让连接桥「装死」：还在，但什么都不回
    muteContext(h.aliveDocs()[0]);

    const t0 = Date.now();
    const res = await h.sendToWorker({ type: 'action', action: 'set_vol', vol: 9 }, 12000);
    const elapsed = Date.now() - t0;

    ok(elapsed < 11000, `后台在 ${elapsed}ms 内给了答复（不会让界面干等到超时）`);
    ok(res && res.ok === false, '明确返回失败，而不是静默挂起');
    // 信息要能指导用户下一步操作（重连中/重新加载/重建连接桥 都算合格）
    ok(
      /超时|无响应|没有响应|重新加载|重建|回收/.test(res.error || ''),
      `错误信息可读：${res && res.error}`
    );
  }

  /* ---------------------------------------------------------------- 2. 卡死的桥被回收后恢复 */

  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker();
    await waitFor(h, (s) => s.status === 'online', '先正常连上');
    const stale = h.aliveDocs()[0];

    muteContext(stale);
    if (stale.sandbox && stale.sandbox.window) stale.sandbox.window.close = function () {};

    for (let i = 0; i < 3; i++) {
      await h.sendToWorker({ type: 'action', action: 'refresh' }, 12000);
      await sleep(200);
    }

    // 让它真正消失（模拟浏览器回收），验证下一次请求能恢复
    stale.dead = true;
    const recovered = await waitFor(h, (s) => s.status === 'online', '替换掉卡死的连接桥后恢复');
    eq(recovered.status, 'online', '恢复为已连接');
    eq(h.device.vol, 6, '能重新读到音量');

    const set = await h.sendToWorker({ type: 'action', action: 'set_vol', vol: 4 }, 12000);
    ok(set && set.ok, '恢复后指令可用');
    eq(h.device.vol, 4, '音箱音量被改了');
  }

  /* ---------------------------------------------------------------- 3. 诊断接口始终可用 */

  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker();
    await waitFor(h, (s) => s.status === 'online', '先正常连上');
    muteContext(h.aliveDocs()[0]);

    const t0 = Date.now();
    const diag = await h.sendToWorker({ type: 'diag' }, 3000);
    const elapsed = Date.now() - t0;
    ok(elapsed < 1000, `诊断接口 ${elapsed}ms 内返回`);
    ok(diag && diag.ok, '诊断接口可用');
    ok(diag.result && typeof diag.result.bridge === 'boolean', '诊断里带连接桥状态');
    ok(diag.result.lastRequest, '诊断里记录了最近一次请求');
  }

  /* ---------------------------------------------------------------- 4. 桥被创建但脚本没跑起来 */

  // 最阴的一种：createDocument 成功，后台若据此认为桥可用，
  // 界面就会一直「连接桥无响应」。这里要求后台必须发现并如实上报。
  // 注意：不回答的文档同时也关不掉，Chrome 又不允许同时存在两个，
  // 所以后台无法自愈 —— 但它必须不再谎报可用，并给出可操作的原因。
  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker({ offscreen: { scriptless: true } });

    const res = await h.sendToWorker({ type: 'get_state' }, 20000);
    ok(res && !res.__timeout, '后台有答复（不会卡住）');

    for (let i = 0; i < 80 && h.allDocs().length < 2; i++) await sleep(100);

    const diag = await h.sendToWorker({ type: 'diag' }, 5000);
    ok(diag && diag.ok, '诊断接口可用');
    ok(diag.result && diag.result.bridge === false, '不再谎报连接桥可用');
    ok(
      !!(diag.result && diag.result.lastError),
      `诊断里记录了原因（实际：${diag.result && diag.result.lastError}）`
    );
    ok(/连接桥|重新加载/.test((diag.result && diag.result.lastError) || ''), '原因可读、指向连接桥');
  }

  /* ---------------------------------------------------------------- 5. 这种桥被回收后必须自动恢复 */

  // 说明：一个「创建了但不回话」的文档同时也关不掉，而 Chrome 不允许同时存在两个
  // 屏幕外文档，所以后台无法从这种状态里自愈 —— 那一轮的期望是「如实上报」。
  // 这里验证的是「它恢复了之后确实能用」：一旦坏文档真的消失，下一次请求必须重建出可用的桥。
  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker({ offscreen: { scriptless: true } });
    await h.sendToWorker({ type: 'get_state' }, 20000);
    await sleep(600);

    // 坏文档真的消失（浏览器回收 / 用户点重新加载）
    h.contexts
      .filter((c) => c.kind === 'offscreen')
      .forEach((c) => {
        c.scriptless = false;
        c.dead = true;
      });

    // 关键：断言「重建时会真的握手确认」，这是这次修复的核心 ——
    // 只凭 createDocument 成功就认为桥可用，正是之前「桥已存在但从不工作」的根因。
    let helloSeen = false;
    h.contexts.push({
      id: 'spy',
      kind: 'ui',
      dead: false,
      messageEvent: {
        listeners: [
          function (msg) {
            if (msg && msg.type === 'hello' && msg.nonce) helloSeen = true;
          }
        ]
      }
    });

    const state = await waitFor(h, (s) => s.status === 'online' && s.bridge, '坏桥消失后重建并恢复');
    eq(state.status, 'online', '恢复为已连接');
    eq(state.bridge, true, '重建后的桥被确认可用');
    eq(h.device.vol, 6, '读到真实音量');
    ok(helloSeen, '重建时确实做了 nonce 握手确认（不再只凭 createDocument 成功就放行）');

    const set = await h.sendToWorker({ type: 'action', action: 'set_vol', vol: 3 }, 12000);
    ok(set && set.ok, '恢复后指令通道可用');
    eq(h.device.vol, 3, '音箱音量被改了');
  }

  /* ---------------------------------------------------------------- 6. 重建失败必须给出原因（不能是空字符串） */

  // 这是真实踩过的坑：ensureOffscreen 可能「成功返回但桥其实不可用」，
  // 于是 resetBridge 走上成功分支，lastBootError 停在空字符串，
  // 界面只能显示「重建后仍不可用：」后面什么都没有。
  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker({ offscreen: { scriptless: true } });
    await h.sendToWorker({ type: 'get_state' }, 20000);
    await sleep(400);

    const res = await h.sendToWorker({ type: 'bridge:reset' }, 30000);
    ok(res && res.ok, '重建指令本身返回 ok（内部失败不算接口失败）');
    const out = res.result || {};
    eq(out.bridge, false, '桥确实没建起来时如实回报失败');
    ok(typeof out.error === 'string' && out.error.length > 0, `失败时必须带原因（实际：${JSON.stringify(out.error)}）`);

    const diag = await h.sendToWorker({ type: 'diag' }, 5000);
    ok(diag.result && diag.result.bridgeStage, '诊断里能看出建桥卡在哪一步');
    ok(
      !!(diag.result && diag.result.lastError),
      `诊断的最后错误不能为空（实际：${JSON.stringify(diag.result && diag.result.lastError)}）`
    );
  }

  /* ---------------------------------------------------------------- 7. 屏幕外文档里 chrome.storage 不可用 */

  // 真实故障：manifest 声明了 storage，但在某些 Chrome 版本的屏幕外文档里
  // chrome.storage 就是 undefined（而 chrome.runtime 正常）。
  // 连接桥必须降级运行（设置改向 service worker 要），绝不能因此判自己死刑。
  {
    const h = createHarness({ device: { vol: 8 } });
    h.loadWorker({ offscreen: { noStorage: true } });

    const state = await waitFor(h, (s) => s.status === 'online' && s.bridge, '无 storage 时依然能连上');
    eq(state.status, 'online', '连接桥活着并连上了音箱');
    eq(state.device.vol, 8, '能读到真实音量');

    const diag = await h.sendToWorker({ type: 'diag' }, 5000);
    const bootLog = (diag.result.bootLog || []).join(' | ');
    ok(
      /chrome\.storage 不可用/.test(bootLog),
      `自报历史里能看到降级路径（实际：${bootLog}）`
    );
    ok(/开始连接音箱|设置读取完成/.test(bootLog), `降级后确实继续走到了连接音箱（实际：${bootLog}）`);

    const set = await h.sendToWorker({ type: 'action', action: 'set_vol', vol: 2 }, 12000);
    ok(set && set.ok, '指令通道可用');
    eq(h.device.vol, 2, '音箱音量被改了');
  }

  /* ---------------------------------------------------------------- 8. 更早版本的连接桥（不认识 hello 握手） */

  // 真实情况：扩展重载后，浏览器里可能还留着一个「旧版本创建」的连接桥。
  // 它功能完好（能连音箱、能答 ping），但不知道 hello/nonce 协议。
  // 后台必须照常采纳它的状态，而不是因为它对不上握手就把状态全部丢掉。
  {
    const h = createHarness({ device: { vol: 11 } });
    h.loadWorker();
    await waitFor(h, (s) => s.status === 'online' && s.bridge, '先正常连上');

    // 把活着的文档伪装成「旧版本创建」：它不认识 hello 协议，握手指纹永远对不上
    const doc = h.aliveDocs()[0];
    doc.legacy = true;
    doc.nonce = null;

    const state = await waitFor(h, (s) => s.status === 'online', '旧版连接桥的状态仍被采纳');
    eq(state.status, 'online', '状态照常被采纳（不会因为握手对不上就丢光）');
    eq(state.device.vol, 11, '音量来自真实设备');

    const set = await h.sendToWorker({ type: 'action', action: 'set_vol', vol: 7 }, 15000);
    ok(set && set.ok, '旧版连接桥也能接收指令');
    eq(h.device.vol, 7, '音箱音量被改了');
  }

  /* ---------------------------------------------------------------- 9. storage 读不出来也不能卡住界面 */
  {
    const h = createHarness({ device: { vol: 6 } });
    h.loadWorker();
    // 让 storage 永远不返回（真实冷启动中可能出现）
    h.worker.api.storage.local.get = function () {
      return new Promise(function () {});
    };

    const res = await h.sendToWorker({ type: 'get_state' }, 6000);
    ok(res && !res.__timeout, 'storage 卡住时界面依然能拿到答复');
    ok(res && res.ok, '返回 ok（用默认设置兜底）');
  }

  /* ---------------------------------------------------------------- 结果 */

  console.log(`故障注入测试：${passed} 项通过`);
  if (failures.length) {
    console.log(`\n${failures.length} 项失败：`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
}

run().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
