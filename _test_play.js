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
  const api = new DouyinAPI(cookie, null, { timeout: 15, maxRetry: 2 });

  // 1. 看当前登录者(么么哈哈)自己的作品是否有 play_count
  // 先取自己的 uid
  const self = await api.request('https://www.douyin.com/aweme/v1/web/user/profile/self/', {});
  const me = self && self.user;
  console.log('[Test] 当前登录者:', me && me.nickname, '| uid:', me && me.uid, '| aweme_count:', me && me.aweme_count);

  // 2. 抓自己的作品列表
  if (me && me.sec_uid) {
    const r = await api.getUserVideos(me.sec_uid, 0, 20);
    const list = (r.aweme_list || []) || [];
    console.log('[Test] 自己作品列表:', list.length, '条');
    for (const v of list.slice(0, 5)) {
      const st = v.statistics || {};
      console.log(`[Test]   ${(v.desc || '').slice(0, 20)} | play_count=${st.play_count} | digg=${st.digg_count} | comment=${st.comment_count}`);
    }
  }

  // 3. 抓别人的作品(玉米千层猫)看 play_count
  const r2 = await api.getUserVideos('MS4wLjABAAAAjeaiO8JGy9pdNEiBmT2LtPs0r6BrEnNoiMhZxIe7kHU', 0, 20);
  const list2 = (r2.aweme_list || []) || [];
  console.log('[Test] 别人作品列表:', list2.length, '条');
  let withPlay = 0;
  for (const v of list2.slice(0, 8)) {
    const st = v.statistics || {};
    if (st.play_count !== undefined && st.play_count > 0) withPlay++;
    console.log(`[Test]   ${(v.desc || '').slice(0, 20)} | play_count=${st.play_count}`);
  }
  console.log('[Test] 别人作品带播放量的:', withPlay, '/', Math.min(8, list2.length));
})().catch(e => { console.error('[Test] 失败:', e.message); process.exit(1); });
