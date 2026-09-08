const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { DouyinAPI } = require('./src/native/apiService');

(async () => {
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const dbPath = path.join(process.env.APPDATA || '', 'douyin-downloader', 'app.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const getKV = (key, fallback) => {
    const stmt = db.prepare('SELECT value FROM kv WHERE key=?');
    stmt.bind([key]);
    const r = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch (_) { return fallback; }
  };
  const cookie = getKV('cookie_douyin', '') || '';
  const api = new DouyinAPI(cookie, null, { timeout: 15, maxRetry: 1 });

  // 空 sec_user_id
  const r1 = await api.getUserProfile('');
  console.log('[Test] getUserProfile(""): user=', r1.user ? r1.user.nickname : '(无)', '| code=', r1.status_code, '| msg=', r1.status_msg);
  if (r1.user) console.log('[Test]   -> 返回了用户! uid=', r1.user.uid, '这是不是登录账号?');

  // 只传 user/profile 段(可能被某些逻辑截取)
  const r2 = await api.getUserProfile('64f6b3fd000000000200d005');
  console.log('[Test] getUserProfile(纯ID): user=', r2.user ? r2.user.nickname : '(无)', '| code=', r2.status_code, '| msg=', r2.status_msg);
})().catch(e => { console.error('[Test] 失败:', e.message); process.exit(1); });
