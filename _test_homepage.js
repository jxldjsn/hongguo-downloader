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

  const xhsUrl = 'https://www.xiaohongshu.com/user/profile/64f6b3fd000000000200d005?m_source=pwa&channel_type=explore_feed&parent_page_channel_type=web_profile_board&xsec_token=ABrnpDSJXHc24YKEvaL3U3wHNeE_Fa1PYaJncO-afUgW8=&xsec_source=pc_note';

  // 模拟首页: resolveShareLink(小红书链接)
  try {
    const resolved = await api.resolveShareLink(xhsUrl);
    console.log('[Test] resolveShareLink 返回:', (resolved || '').slice(0, 200));
    // 首页提取逻辑
    const modal = resolved.match(/modal_id=(\d+)/);
    const video = resolved.match(/video\/(\d+)/);
    const slides = resolved.match(/slides\/(\d+)/) || resolved.match(/note\/(\d+)/);
    const digits = resolved.match(/\d{19}/);
    console.log('[Test] modal_id:', modal ? modal[1] : '无');
    console.log('[Test] /video/:', video ? video[1] : '无');
    console.log('[Test] slides/note:', slides ? slides[1] : '无');
    console.log('[Test] 19位数字:', digits ? digits[0] : '无');
    if (digits) {
      // 若提取到 19 位数字, 用 getVideoDetail 查
      try {
        const d = await api.getVideoDetail(digits[0]);
        const item = d.aweme_detail || {};
        console.log('[Test] getVideoDetail(19位) 作者:', item.author && item.author.nickname, '| desc:', (item.desc || '').slice(0, 30));
      } catch (e) { console.log('[Test] getVideoDetail 失败:', e.message); }
    }
  } catch (e) {
    console.log('[Test] resolveShareLink 失败:', e.message);
  }
})().catch(e => { console.error('[Test] 失败:', e.message); process.exit(1); });
