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

  // 模拟 ProfileDownload: 把小红书链接整个当 sec_user_id
  const xhsUrl = 'https://www.xiaohongshu.com/user/profile/64f6b3fd000000000200d005?m_source=pwa&xsec_token=ABrnpDSJXHc24YKEvaL3U3wHNeE_Fa1PYaJncO-afUgW8=&xsec_source=pc_note';
  console.log('[Test] 小红书链接:', xhsUrl.slice(0, 60) + '...');
  console.log('[Test] 是否含 douyin.com:', /douyin\.com/i.test(xhsUrl));
  console.log('[Test] 是否含 v.douyin.com:', /v\.douyin\.com/i.test(xhsUrl));

  const resp = await api.getUserProfile(xhsUrl);
  const user = resp && resp.user;
  console.log('[Test] 抖音 getUserProfile(小红书链接) 返回用户:', user ? user.nickname : '(无)');
  console.log('[Test] 用户 uid:', user && user.uid, '| sec_uid:', user && user.sec_uid && user.sec_uid.slice(0, 20));
  console.log('[Test] 返回码:', resp && resp.status_code, '| 说明:', resp && resp.status_msg);
})().catch(e => { console.error('[Test] 失败:', e.message); process.exit(1); });
