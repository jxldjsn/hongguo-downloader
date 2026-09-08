/* 验证爆款分析弹窗修复：账号管理 + 我的账号 两处入口均正常打开，无错误边界 */
const http = require('http');
const WebSocket = require('ws');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
async function connect() {
  const pages = await getJson('http://127.0.0.1:9222/json');
  const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', buf => {
    const msg = JSON.parse(buf.toString());
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  });
  return { ws, eval: (expr) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); }) };
}

(async () => {
  const cdp = await connect();
  const E = cdp.eval;

  for (let i = 0; i < 30; i++) { const r = await E(`!!document.querySelector('.sidebar-tab-ops')`); if (r.result.value) break; await sleep(500); }
  await E(`document.querySelector('.sidebar-tab-ops')?.click(); true`); await sleep(800);

  // 记录渲染异常（React error boundary 出现即失败）
  const hasError = () => E(`(() => {
    const t = document.body.textContent;
    return {
      boundary: !!document.querySelector('.account-modal-overlay'),
      errText: t.includes('弹窗加载遇到异常') ? t.match(/弹窗加载遇到异常[\s\S]{0,80}/)?.[0] : null,
      filmErr: t.includes('Film is not defined'),
    };
  })()`);

  // ===== 1. 账号管理 → 分组爆款分析 =====
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.querySelector('.nav-label')?.textContent.trim() === '账号管理'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  const opened1 = await E(`(() => { const b = document.querySelector('.group-sidebar-analysis-entry'); if (!b) return { err: '未找到分组爆款分析按钮' }; b.click(); return true; })()`);
  console.log('[账号管理] 点击分组爆款分析 =', JSON.stringify(opened1.result.value));
  await sleep(5000);
  const st1 = (await hasError()).result.value;
  const modal1 = await E(`(() => { const m = document.querySelector('.hvam-modal'); if (!m) return { err: '弹窗未渲染' }; return { title: m.querySelector('.hvam-title')?.textContent?.trim(), bodyLen: m.textContent.length, hasWorksArea: m.textContent.includes('条作品') || m.textContent.includes('作品') }; })()`);
  console.log('[账号管理] 错误检测 =', JSON.stringify(st1));
  console.log('[账号管理] 弹窗内容 =', JSON.stringify(modal1.result.value));
  // 关闭
  await E(`(() => { const m = document.querySelector('.hvam-modal'); const btn = m?.querySelector('.hvam-close, button'); btn?.click(); return !!btn; })()`);
  await sleep(500);

  // ===== 2. 我的账号 → 爆款分析 =====
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.querySelector('.nav-label')?.textContent.trim() === '我的账号'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  const opened2 = await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('爆款分析')); if (!b) return { err: '未找到爆款分析按钮' }; b.click(); return true; })()`);
  console.log('[我的账号] 点击爆款分析 =', JSON.stringify(opened2.result.value));
  await sleep(5000);
  const st2 = (await hasError()).result.value;
  const modal2 = await E(`(() => { const m = document.querySelector('.hvam-modal'); if (!m) return { err: '弹窗未渲染' }; return { title: m.querySelector('.hvam-title')?.textContent?.trim(), bodyLen: m.textContent.length }; })()`);
  console.log('[我的账号] 错误检测 =', JSON.stringify(st2));
  console.log('[我的账号] 弹窗内容 =', JSON.stringify(modal2.result.value));

  cdp.ws.close();
  process.exit(0);
})().catch(e => { console.error('[TEST] 失败:', e.message); process.exit(1); });
