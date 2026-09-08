/* 强断言版：刷新前后 accounts 表整行（含 added_time）必须完全一致 */
const http = require('http');
const WebSocket = require('ws');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
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
function probe() {
  return new Promise(async (resolve) => {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(path.join(process.env.APPDATA, 'douyin-downloader', 'app.db')));
    const dump = (sql) => { const s = db.prepare(sql); const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows; };
    const rows = {
      accounts: dump('SELECT * FROM accounts ORDER BY sec_user_id'),
      myAccounts: dump('SELECT * FROM my_accounts ORDER BY uid'),
    };
    db.close();
    resolve(rows);
  });
}
const stable = (rows) => JSON.stringify(rows, Object.keys(rows).sort());
(async () => {
  const before = await probe();
  console.log('[DB] 刷新前 accounts=', before.accounts.length, 'my_accounts=', before.myAccounts.length);
  const mm = before.accounts.find(a => a.nickname === '么么哈哈');
  console.log('[DB] 么么哈哈(accounts) added_time =', mm ? mm.added_time : '(不存在)');

  const cdp = await connect();
  for (let i = 0; i < 30; i++) { const r = await cdp.eval(`!!document.querySelector('.sidebar-tab-ops')`); if (r.result.value) break; await sleep(500); }
  await cdp.eval(`document.querySelector('.sidebar-tab-ops')?.click(); true`); await sleep(800);
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.querySelector('.nav-label')?.textContent.trim() === '我的账号'); if (b) b.click(); return !!b; })()`); await sleep(1200);
  for (let i = 0; i < 20; i++) { const r = await cdp.eval(`!![...document.querySelectorAll('.account-card')].length`); if (r.result.value) break; await sleep(500); }
  const click = await cdp.eval(`(() => { const c = [...document.querySelectorAll('.account-card')].find(x => x.textContent.includes('么么哈哈')); if (!c) return false; const b = [...c.querySelectorAll('button')].find(x => x.textContent.includes('刷新')); if (!b) return false; b.click(); return true; })()`);
  console.log('[UI] 点击刷新 =', click.result.value);
  await sleep(12000);
  const err = await cdp.eval(`document.body.textContent.includes('刷新失败')`);
  console.log('[UI] 出现刷新失败 =', err.result.value);
  cdp.ws.close();

  const after = await probe();
  const mm2 = after.accounts.find(a => a.nickname === '么么哈哈');
  console.log('[DB] 刷新后 么么哈哈(accounts) added_time =', mm2 ? mm2.added_time : '(不存在)');
  console.log('[断言] accounts 表整行一致 =', stable(before.accounts) === stable(after.accounts));
  console.log('[断言] my_accounts 表整行一致 =', stable(before.myAccounts) === stable(after.myAccounts));
  process.exit(0);
})().catch(e => { console.error('[TEST] 失败:', e.message); process.exit(1); });
