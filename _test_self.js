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
  const self = await api.request('https://www.douyin.com/aweme/v1/web/user/profile/self/', {});
  const user = self && self.user;
  console.log('[Test] self 返回:', !!user);
  if (user) {
    console.log('[Test] uid:', user.uid, '| sec_uid:', user.sec_uid, '| nickname:', user.nickname);
    console.log('[Test] avatar:', user.avatar_thumb && user.avatar_thumb.url_list && user.avatar_thumb.url_list[0] ? '有' : '无');
    console.log('[Test] aweme_count:', user.aweme_count, '| follower:', user.follower_count, '| favoriting:', user.total_favorited);
  }
})().catch(e => { console.error('[Test] 失败:', e.message); process.exit(1); });
