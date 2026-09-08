/**
 * 运行时验证: 通过 CDP 驱动 Electron 应用，在“账号管理”页点击“加标签”，
 * 验证标签弹窗能正常打开、能新建标签、能保存绑定，且全程无白屏/无未捕获异常。
 * 用法: 先启动 electron . --remote-debugging-port=9222，再运行 node _ui_test_tags.js
 */
const http = require('http');
const WebSocket = require('ws');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson('http://127.0.0.1:9222/json/list');
      const page = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch (e) { /* CDP 未就绪 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('等待应用窗口超时');
}

async function main() {
  const target = await waitForTarget(60000);
  console.log('[Test] 已连接窗口:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else events.push(m);
  });
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('[页面异常] ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    }
    return r.result ? r.result.result.value : undefined;
  };

  // 1. 等应用渲染 -> 点侧边栏“账号管理” -> 点第一个“+ 标签”按钮
  const result = await evalJs(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = { rootChildren: 0 };
    // 等待 React 根节点渲染
    for (let i = 0; i < 80; i++) {
      const root = document.querySelector('#root');
      out.rootChildren = root ? root.children.length : 0;
      if (out.rootChildren > 0) break;
      await sleep(500);
    }
    if (out.rootChildren === 0) return { ok: false, step: 'app-not-rendered', ...out, body: document.body.innerText.slice(0, 200) };

    // 切换到「运营」模式，然后点击侧边栏「账号管理」
    const opsTab = document.querySelector('.sidebar-tab-ops');
    if (opsTab) opsTab.click();
    await sleep(800);
    const navBtn = [...document.querySelectorAll('.nav-label')].find(el => el.textContent.trim() === '账号管理');
    if (!navBtn) return { ok: false, step: 'nav-not-found', ...out, body: document.body.innerText.slice(0, 200) };
    navBtn.closest('button').click();
    await sleep(2000);

    // 等账号卡片上的「+ 标签」按钮出现
    let btn = null;
    for (let i = 0; i < 20; i++) {
      btn = document.querySelector('.add-tag-chip-btn');
      if (btn) break;
      await sleep(500);
    }
    if (!btn) return { ok: false, step: 'add-tag-btn-not-found', ...out, body: document.body.innerText.slice(0, 200) };

    // 点击「+ 标签」——修复前此处白屏
    btn.click();
    await sleep(1000);

    const rootAfter = document.querySelector('#root');
    out.rootChildrenAfterClick = rootAfter ? rootAfter.children.length : 0;
    const modal = document.querySelector('.tag-edit-modal');
    if (!modal || out.rootChildrenAfterClick === 0) {
      return { ok: false, step: 'white-screen-or-no-modal', ...out, body: document.body.innerText.slice(0, 200) };
    }

    // 2. 新建一个测试标签
    const input = document.querySelector('.tag-edit-input');
    const newTag = '测试标签' + (Date.now() % 100000);
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSet.call(input, newTag);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const createBtn = [...document.querySelectorAll('.add-preset-tag-bar button')].find(b => b.textContent.includes('新建标签'));
    createBtn.click();
    await sleep(300);
    const poolNames = [...document.querySelectorAll('.tag-toggle-name')].map(el => el.textContent);
    out.poolHasNewTag = poolNames.includes(newTag);
    out.selectedCount = document.querySelectorAll('.tag-toggle-chip.selected').length;

    // 3. 取消勾选新建的标签，再点「保存绑定」→ 走真实 IPC，且账号标签保持不变
    const newChip = [...document.querySelectorAll('.tag-toggle-chip')].find(c => c.querySelector('.tag-toggle-name')?.textContent === newTag);
    newChip.click();
    await sleep(300);
    const saveBtn = [...document.querySelectorAll('.tag-edit-footer button')].find(b => b.textContent.includes('保存绑定'));
    saveBtn.click();
    await sleep(1000);
    out.modalClosedAfterSave = !document.querySelector('.tag-edit-modal');
    const rootFinal = document.querySelector('#root');
    out.rootChildrenFinal = rootFinal ? rootFinal.children.length : 0;

    out.ok = out.poolHasNewTag && out.modalClosedAfterSave && out.rootChildrenFinal > 0;
    out.step = 'complete';
    return out;
  })()`);

  console.log('[Test] 结果:', JSON.stringify(result, null, 2));

  // 汇总页面异常事件
  await new Promise(r => setTimeout(r, 500));
  const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded');
  const fatal = exceptions.filter(e => {
    if (e.method === 'Runtime.exceptionThrown') return true;
    return e.params && e.params.entry && e.params.entry.level === 'error';
  });
  console.log('[Test] 页面错误事件:', fatal.length ? JSON.stringify(fatal.map(e => e.params && (e.params.exceptionDetails?.text || e.params.entry?.text))) : '无');

  const pass = result.ok && fatal.length === 0;
  console.log(pass ? '\n[Test] ✅ 通过: 加标签功能正常，无白屏' : '\n[Test] ❌ 失败');
  ws.close();
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('[Test] 驱动失败:', e.message); process.exit(1); });
