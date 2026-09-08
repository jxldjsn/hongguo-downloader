/**
 * 小红书主页批量抓取（基于隐藏 BrowserWindow）
 *
 * 背景：小红书 web API（/api/sns/web/v1/user_posted、/api/sns/web/v1/feed）
 * 强制要求 x-s / x-t / x-s-common 签名，算法是混淆 JS，纯 Node 复刻随版本失效不可取。
 *
 * 方案（复用项目已验证的 tiktokProfile.js / channelsLogin.js 模式）：
 *   用隐藏 BrowserWindow 加载小红书主页，页面自身的 axios 拦截器会自动给
 *   /api/sns/web/ 请求加签。我们只需注入脚本包装 fetch 捕获 user_posted 响应 +
 *   自动滚动触发分页，即可累计全部作品；下载时在同一窗口上下文里 fetch feed
 *   接口拿完整下载 URL（同样免签名）。
 *
 * 登录态：小红书主页需登录才能看到全量作品。cookie 通过 CookieManager 登录后
 * 存入 DB（cookie_xiaohongshu），创建隐藏窗口时用 session.cookies.set 注入。
 *
 * 对外暴露：
 *   - fetchUserNotes(profileUrl) -> { user, notes: [{noteId,title,type,cover,...}] }
 *   - fetchNoteDetail(noteId)    -> note_card（feed 接口返回的原始结构，含视频流/图集URL）
 *   - destroy()                  -> 销毁隐藏窗口
 */

const { BrowserWindow, session } = require('electron');
const db = require('./database');

const XHS_ORIGIN = 'https://www.xiaohongshu.com';
const FEED_API = 'https://edith.xiaohongshu.com/api/sns/web/v1/feed';

let xhsWindow = null;
let windowReadyPromise = null;
let operationQueue = Promise.resolve();
let windowGeneration = 0;
// 最近一次加载的主页 URL（webpack runtime 丢失时重载用）
let lastProfileUrl = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的 executeJavaScript：窗口未加载页面（或页面卡死）时 executeJavaScript
 * 会永久挂起（不 resolve 也不 reject），导致调用方卡住。用 Promise.race 兜底超时。
 * @param {BrowserWindow} win
 * @param {string} js JS 代码
 * @param {number} timeoutMs 超时毫秒
 * @param {*} fallback 超时/失败时的返回值
 */
async function execJS(win, js, timeoutMs = 10000, fallback = undefined) {
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(js),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面JS执行超时(' + (timeoutMs / 1000) + 's)')), timeoutMs)),
    ]);
  } catch (e) {
    return fallback;
  }
}

/**
 * 从主页 URL 中提取 userId
 * 支持 https://www.xiaohongshu.com/user/profile/64283ee1... 及短链
 */
function parseUserId(url) {
  if (!url) return '';
  let s = String(url).trim();
  // 标准主页 URL
  const m = s.match(/user\/profile\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // 纯 userId 兜底
  s = s.split(/[?#/]/).filter(Boolean).pop() || '';
  return s;
}

/**
 * 解析 cookie 字符串为 [{name, value}] 列表
 */
function parseCookieString(cs) {
  if (!cs) return [];
  return String(cs).split(';').map(kv => {
    const idx = kv.indexOf('=');
    if (idx < 0) return null;
    const name = kv.slice(0, idx).trim();
    const value = kv.slice(idx + 1).trim();
    return name ? { name, value } : null;
  }).filter(Boolean);
}

/**
 * 从 DB 读取已保存的小红书 cookie，注入到指定 session（隐藏窗口登录态）
 *
 * 注意：不能强制 secure:true + httpOnly:true。
 * 小红书很多 cookie（a1/webId/gid 等）原本是 non-secure、non-httpOnly 的，
 * 强制设置会导致 ses.cookies.set 静默失败或 cookie 不被发送，表现为「已登录但抓不到」。
 * 这里只设最关键的 url/name/value/path/domain，让 Electron 用宽松默认值。
 * 同名 cookie（如多个 acw_tc）后者覆盖前者即可，不影响登录态。
 */
async function injectCookies(ses) {
  const cs = db.getKV('cookie_xiaohongshu', '') || '';
  if (!cs) return false;
  const cookies = parseCookieString(cs);
  let ok = 0;
  let fail = 0;
  for (const c of cookies) {
    try {
      // 若分区 session 里已有**正确域(.xiaohongshu.com)**的同名 cookie（登录窗口刚写入的
      // 新 cookie，比 DB 里的旧值新），保留 session 的，跳过注入——避免用 DB 旧 cookie
      // 覆盖掉用户刚登录的新会话。
      // 注意：必须按 .xiaohongshu.com 域检查。应用启动时 syncCookiesToSession 用
      // www.xiaohongshu.com 写入的 cookie 域不覆盖 API 子域 edith.xiaohongshu.com
      // （user_posted/feed 接口在 edith 域，www 域 cookie 不会随请求发送），
      // 若用 url=XHS_ORIGIN 检查会误判"已有"而跳过注入，导致接口返回 -101 无登录信息。
      const existing = await ses.cookies.get({ domain: '.xiaohongshu.com', name: c.name }).catch(() => []);
      if (existing && existing.length > 0 && String(existing[0].value || '').length > 0) {
        ok++; // 视为已就绪（session 有值即可），不覆盖
        continue;
      }
      // session 无同名 cookie：从 DB 注入。先 remove 残留（属性冲突/过期残留会导致
      // set 覆盖失败，表现为 web_session/id_token 等报 "Setting cookie failed"）。
      try { await ses.cookies.remove(XHS_ORIGIN, c.name); } catch (_) { /* ignore */ }
      await ses.cookies.set({
        url: XHS_ORIGIN,
        name: c.name,
        value: c.value,
        domain: '.xiaohongshu.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'no_restriction',
      });
      ok++;
    } catch (e) {
      fail++;
      console.warn('[XhsProfile] cookie 注入失败:', c.name, e.message);
    }
  }
  console.log('[XhsProfile] 已注入 cookie', ok, '/', cookies.length, '失败', fail);
  return ok > 0;
}

/**
 * 等待窗口加载完成（含 JS 首屏请求），带超时
 * loadURL 本身会等 did-finish-load，但小红书首页是 SPA，首屏数据请求在 finish 之后，
 * 需额外等待 user_posted 接口返回或超时。
 *
 * 同时监听 did-fail-load：网络错误/被风控时 did-finish-load 可能不触发，
 * 没有这个兜底会一直等到 timeoutMs 才返回，表现为"一直加载中"。
 */
async function waitReady(win, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    let settleTimer = null;
    let timeoutTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { win.webContents.removeListener('did-finish-load', onDidFinishLoad); } catch (e) {}
      try { win.webContents.removeListener('did-fail-load', onDidFailLoad); } catch (e) {}
      resolve();
    };
    const onDidFinishLoad = () => {
      settleTimer = setTimeout(finish, 1200);
    };
    const onDidFailLoad = () => finish();
    // did-finish-load 后再等一拍让首屏接口发出去
    win.webContents.once('did-finish-load', onDidFinishLoad);
    // did-fail-load 也算加载结束（网络错误/超时），立即继续
    win.webContents.once('did-fail-load', onDidFailLoad);
    // 兜底超时
    timeoutTimer = setTimeout(finish, timeoutMs);
  });
}

/**
 * 带超时的 loadURL：loadURL 本身无超时，网络慢/风控时会一直 hang 住，
 * 表现为前端卡在"正在加载主页"。用 Promise.race 兜底，超时后强制继续
 * （此时页面可能已部分加载，后续读 __INITIAL_STATE__ 仍有机会拿到数据）。
 */
async function loadURLWithTimeout(win, url, timeoutMs = 15000) {
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadURL 超时')), timeoutMs)),
    ]);
  } catch (e) {
    console.warn('[XhsProfile] loadURL 异常/超时，继续尝试读取页面数据:', e.message);
  }
}

/**
 * 创建/复用隐藏窗口（单例）
 * 返回 BrowserWindow 实例
 */
async function ensureWindow() {
  if (xhsWindow && !xhsWindow.isDestroyed()) return xhsWindow;
  if (windowReadyPromise) return windowReadyPromise;

  const generation = windowGeneration;
  const createWindowPromise = (async () => {
    const ses = session.fromPartition('persist:xiaohongshu');
    // 注入已保存的登录 cookie（若有）
    const injected = await injectCookies(ses);
    console.log('[XhsProfile] 隐藏窗口 cookie 注入结果:', injected);

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,  // 允许后台窗口正常执行 JS + 计时器
        session: ses,
      },
    });

    // 设置通用 UA，避免小红书对异常 UA 风控
    await win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    if (generation !== windowGeneration) {
      try { win.destroy(); } catch (_) { /* ignore */ }
      throw new Error('小红书隐藏窗口已重置');
    }
    xhsWindow = win;
    win.on('closed', () => {
      if (xhsWindow === win) xhsWindow = null;
    });
    return win;
  })();

  windowReadyPromise = createWindowPromise.finally(() => {
    if (windowReadyPromise === guardedPromise) windowReadyPromise = null;
  });
  const guardedPromise = windowReadyPromise;
  return windowReadyPromise;
}

function enqueueOperation(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

/**
 * 把笔记对象映射成统一展示结构
 *
 * 兼容两种数据源：
 *   1) user_posted API（下划线命名）：note.note_id / note.display_title /
 *      note.interact_info.liked_count / note.cover.info_list[].url / note.cover.url_pre
 *   2) SSR（驼峰命名，老版兼容）：noteCard.displayTitle / noteCard.cover.urlDefault /
 *      noteCard.interactInfo.likedCount
 *
 * user_posted 列表不区分视频/图集（type 都是 'normal'），需 feed 详情接口判定。
 */
function normalizeNote(note) {
  const nc = note.noteCard || note.note_card || note;
  const user = nc.user || note.user || {};
  const interact = nc.interactInfo || nc.interact_info || note.interact_info || {};
  const cover = nc.cover || note.cover || {};

  // 封面 URL：优先 urlDefault / urlPre（SSR/API），其次 info_list[0].url / url_list[0] / url
  let coverUrl = cover.urlDefault || cover.urlPre || cover.url_pre || cover.url || '';
  if (!coverUrl && cover.url_list) coverUrl = cover.url_list[0] || '';
  if (!coverUrl && cover.infoList) coverUrl = (cover.infoList[0] && cover.infoList[0].url) || '';
  if (!coverUrl && cover.info_list) coverUrl = (cover.info_list[0] && cover.info_list[0].url) || '';
  // 升级 http -> https（小红书 CDN 支持 https，避免混合内容拦截）
  if (coverUrl && coverUrl.indexOf('http://') === 0) coverUrl = 'https://' + coverUrl.slice(7);

  // type: 列表全是 'normal'（不区分视频/图集，需详情接口判定）；视频笔记详情里 type='video'
  const rawType = nc.type || note.type || '';
  const type = rawType === 'video' ? 'video' : 'image';

  return {
    noteId: note.id || note.note_id || nc.noteId || nc.note_id || '',
    title: nc.displayTitle || nc.display_title || note.display_title || nc.title || '',
    type,
    cover: coverUrl,
    xsecToken: nc.xsecToken || nc.xsec_token || note.xsecToken || '',
    author: {
      uid: user.userId || user.user_id || '',
      name: user.nickname || user.nickName || '',
      avatar: user.avatar || (user.avatar_thumb && (user.avatar_thumb.url || (user.avatar_thumb.url_list || [])[0])) || '',
    },
    statistics: {
      liked: Number(interact.likedCount || interact.liked_count) || 0,
      comment: Number(interact.commentCount || interact.comment_count) || 0,
      collected: Number(interact.collectedCount || interact.collected_count) || 0,
      share: Number(interact.shareCount || interact.share_count) || 0,
    },
    createTime: Number(nc.lastUpdateTime || nc.last_update_time || nc.time || note.time) || 0,
  };
}

/**
 * 确保 webpack runtime 已就绪（webpackChunkxhs_pc_web + __INITIAL_STATE__ 出现）。
 *
 * 隐藏窗口是单例：首次 fetchUserNotes 会 loadURL 主页让 runtime 初始化；
 * 之后 fetchNoteDetail / fetchNoteDetailBatch 复用同一窗口时，runtime 仍在，本函数立即返回。
 * 万一窗口被销毁重建或尚未加载页面，这里会轮询等待最多 6s。
 *
 * @param {BrowserWindow} win
 * @param {number} timeoutMs 轮询总时长
 */
async function ensureWebpackReady(win, timeoutMs = 6000) {
  // 只要求 webpack runtime（webpackChunkxhs_pc_web）就绪即可：dJ 调用只需要它。
  // __INITIAL_STATE__ 是小红书 SPA 的初始状态，页面运行中会被清空/替换（导航、feed 请求后都可能），
  // 不能作为接口环境就绪的条件——否则复用窗口解析详情时会误判"未就绪"导致解析失败。
  const quick = await execJS(win, '!!window.webpackChunkxhs_pc_web', 3000, false);
  if (quick) return true;

  // 未就绪：轮询等待（页面可能还在加载）
  const rounds = Math.max(1, Math.floor(timeoutMs / 300));
  for (let i = 0; i < rounds; i++) {
    const ready = await execJS(win, '!!window.webpackChunkxhs_pc_web', 3000, false);
    if (ready) return true;
    await sleep(300);
  }
  return false;
}

/**
 * 注入 webpack chunk 拿到页面内部的 http 实例（dJ），用于调 user_posted / feed 等需要
 * XYS_ 签名的接口。页面自身加签逻辑会在请求发出前自动补 X-s/X-t/X-S-Common。
 *
 * 原理：webpack 5 的 webpackChunkxhs_pc_web.push([[chunkId], {}, runtime])，
 * runtime 函数会收到 __webpack_require__，用它 require(21403).dJ 就拿到带加签的 http 封装。
 *
 * 调用约定（dJ.get 签名为 (apiKey, data, config)）：
 *   GET  -> dJ.get(path, null, { params: {...} })   // params 进第三参数
 *   POST -> dJ.post(path, body, { params?: {...} })
 *
 * 返回值是 axios 风格 { data, status }，其中 data 是接口 JSON（含 code/success/data 三层）。
 * 我们只关心 data.data（业务数据）。
 *
 * @param {BrowserWindow} win
 * @param {string} method - 'get' | 'post'
 * @param {string} path - API 路径，如 '/api/sns/web/v1/user_posted'
 * @param {object} params - query 参数（GET）或 body（POST）
 * @param {object} [extraConfig] - 额外 config（如 POST 的 params）
 * @returns {Promise<object>} 接口业务数据（resp.data.data）
 */
async function callViaWebpack(win, method, path, params, extraConfig) {
  const isPost = method === 'post';
  const js = `(function(){
    return new Promise(function(resolve, reject){
      try {
        var chunks = window.webpackChunkxhs_pc_web;
        if (!chunks) { reject(new Error('webpackChunkxhs_pc_web 未初始化')); return; }
        chunks.push([['__xhs_call_' + Date.now() + '_' + Math.random().toString(36).slice(2,6)], {}, function(__webpack_require__){
          try {
            var dJ = __webpack_require__(21403).dJ;
            var p = ${JSON.stringify(path)};
            var params = ${JSON.stringify(params || {})};
            var extra = ${JSON.stringify(extraConfig || {})};
            var req;
            if (${isPost ? 'true' : 'false'}) {
              req = dJ.post(p, params, extra);
            } else {
              req = dJ.get(p, null, Object.assign({}, extra, { params: params }));
            }
            req.then(function(resp){
              // dJ.get/post 的 axios 响应：{data, status, headers, ...}
              // 但某些异常情况（页面导航中断请求 / 风控）dJ 会 resolve(null) 或 reject。
              // typeof null === 'object' 的 JS 坑：resp=null 时 respType=object 但 resp falsy。
              if (!resp) {
                resolve(JSON.stringify({ ok: false, error: 'dJ 返回空响应(resp=null)，可能页面被风控跳转或请求被中断', respType: typeof resp }));
                return;
              }
              var body = resp && resp.data !== undefined ? resp.data : resp;
              // 接口有两种响应结构：
              //   1) 标准包装：{code:0, success:true, data:{notes,...}}  -> 取 body.data
              //   2) 裸数据：{notes:[...], has_more, cursor}            -> 直接用 body
              // dJ.get 的 user_posted 实测是裸数据（无 code/success 外壳），用 has_more/notes 字段判定。
              var isWrapped = body && typeof body.code !== 'undefined';
              var isNaked = body && (typeof body.has_more !== 'undefined' || typeof body.hasMore !== 'undefined' || Array.isArray(body.notes) || Array.isArray(body.items));
              if (isWrapped) {
                if (body.code === 0) {
                  resolve(JSON.stringify({ ok: true, data: body.data || null }));
                } else {
                  var pv1 = ''; try { pv1 = JSON.stringify(body).substring(0, 300); } catch(e){}
                  resolve(JSON.stringify({ ok: false, code: body.code, msg: body.msg, bodyPreview: pv1, httpStatus: resp && resp.status }));
                }
              } else if (isNaked) {
                resolve(JSON.stringify({ ok: true, data: body }));
              } else {
                // 既不像包装也不像裸数据：报错并带预览
                // body=null/undefined 常见于页面 webpack 刚初始化但 dJ 还没完全就绪，
                // 或接口返回空响应（风控）。带 resp 完整结构便于诊断。
                var pv2 = ''; try { pv2 = typeof body === 'string' ? body.substring(0, 300) : JSON.stringify(body).substring(0, 300); } catch(e){ pv2 = String(body).substring(0,300); }
                var respInfo = '';
                try { respInfo = ' respType=' + (typeof resp) + ' respKeys=' + (resp ? Object.keys(resp).join(',') : 'null'); } catch(e){}
                resolve(JSON.stringify({ ok: false, code: body && body.code, msg: body && body.msg, bodyPreview: pv2, httpStatus: resp && resp.status, respInfo: respInfo }));
              }
            }).catch(function(err){
              var info = { ok: false, error: err && err.message };
              if (err && err.response) {
                info.status = err.response.status;
                try { info.body = JSON.stringify(err.response.data).substring(0, 500); } catch(e){}
              }
              // dump err 的其他常见字段，便于诊断模糊的 "Error"
              if (err) {
                info.errName = err.name;
                info.errCode = err.code;
                info.errConfig = err.config ? { url: err.config.url, method: err.config.method, data: typeof err.config.data === 'string' ? err.config.data.substring(0,200) : '' } : null;
                try { info.errKeys = Object.keys(err).join(','); } catch(e){}
                try { info.errStr = String(err).substring(0, 300); } catch(e){}
              }
              resolve(JSON.stringify(info));
            });
          } catch(e) { resolve(JSON.stringify({ ok: false, error: e.message, stack: e.stack })); }
        }]);
      } catch(e) { reject(e); }
    });
  })();`;
  // executeJavaScript 本身无超时：页面 JS 卡住（dJ.post 挂起/风控跳转中断）时会永远不返回，
  // 导致 task 卡在"解析中"。用 Promise.race 加 20s 超时兜底。
  const raw = await execJS(win, js, 20000, null);
  if (raw === null) {
    throw new Error('webpack 调用超时或页面无响应(20s)');
  }
  let r;
  try { r = JSON.parse(raw); } catch (e) { throw new Error('webpack 调用返回解析失败: ' + (raw || '').substring(0, 200)); }
  if (!r.ok) {
    const detail = r.msg || r.error || ('code=' + r.code);
    throw new Error('接口调用失败 [' + path + ']: ' + detail
      + (r.status ? ' (HTTP ' + r.status + ')' : '')
      + (r.httpStatus ? ' (resp.status=' + r.httpStatus + ')' : '')
      + (r.bodyPreview ? ' body=' + r.bodyPreview : '')
      + (r.respInfo ? r.respInfo : '')
      + (r.body ? ' errBody=' + r.body : '')
      + (r.errName ? ' errName=' + r.errName : '')
      + (r.errCode ? ' errCode=' + r.errCode : '')
      + (r.errStr ? ' errStr=' + r.errStr : '')
      + (r.errKeys ? ' errKeys=[' + r.errKeys + ']' : '')
      + (r.errConfig ? ' errConfig=' + JSON.stringify(r.errConfig) : ''));
  }
  return r.data;
}

/**
 * 抓取主页全部作品（API 分页方案）
 *
 * 原理：加载主页让 webpack runtime 初始化 -> 注入 chunk 拿到页面内部的 dJ http 实例
 *       -> 循环调 /api/sns/web/v1/user_posted 分页，dJ 会自动加 XYS_ 签名。
 *       比老的 SSR 滚动方案快数倍（一次 API 调用 ~1s，不用等页面渲染+滚动）。
 *
 * 分页参数：cursor 为空串表示第一页；返回的 data.cursor 为下一页游标，空串表示无更多。
 * 终止条件：has_more=false 或 cursor 为空 或 达 300 条 或 最多 30 页。
 *
 * @returns { user, notes }
 */
async function fetchUserNotes(profileUrl, onProgress, maxPages = 30) {
  const userId = parseUserId(profileUrl);
  if (!userId) throw new Error('无法从链接中提取小红书用户 ID');

  const emit = (stage, current, message, percent) => {
    if (typeof onProgress === 'function') {
      try {
        // percent 限制在 0~99（100 留给 done 阶段），避免中间阶段就显示满
        const p = Math.max(0, Math.min(99, Math.round(percent || 0)));
        onProgress({ stage, current: current || 0, message: message || '', percent: p });
      } catch (e) {}
    }
  };

  // 检测登录态：无 cookie 直接提示
  const cs = db.getKV('cookie_xiaohongshu', '') || '';
  if (!cs) {
    throw new Error('NO_COOKIE');
  }
  // 登录态哨兵预检：web_session 是小红书登录后必有的 cookie。
  // 缺失时直接报错（不浪费加载页面 + 调接口的时间），提示用户先登录。
  if (!/(?:^|;\s*)web_session=[^;]+/.test(cs)) {
    throw new Error('小红书未登录（缺少 web_session 登录令牌）。请先在「小红书主页提取」页面登录后再抓取。');
  }

  // 从主页 URL 提取 xsec_token（user_posted 接口需要）
  let xsecToken = '';
  const m = profileUrl.match(/[?&]xsec_token=([^&]+)/);
  if (m) xsecToken = decodeURIComponent(m[1]);

  const win = await ensureWindow();

  // 加载主页一次：让 webpack runtime 初始化（dJ 实例在 require(21403) 后才可用）
  emit('loading', 0, '正在加载小红书主页...', 5);
  await loadURLWithTimeout(win, profileUrl, 15000);
  lastProfileUrl = profileUrl;  // 记录主页 URL，webpack 丢失时可重载恢复
  await waitReady(win, 6000);

  // 检测是否被重定向到登录页 / 登录错误页（风控跳转）
  const currentUrl = win.webContents.getURL();
  if (currentUrl.indexOf('/login') !== -1 || currentUrl.indexOf('passport') !== -1
      || currentUrl.indexOf('website-login') !== -1 || currentUrl.indexOf('/error') !== -1) {
    throw new Error('登录态失效，小红书跳转到了登录页(' + currentUrl.slice(0, 60) + ')。请重新登录小红书后再试。');
  }

  // 等 webpack runtime 就绪（webpackChunkxhs_pc_web 出现即可）
  emit('loading', 0, '正在初始化接口环境...', 15);
  await ensureWebpackReady(win, 6000);

  // 读取目标用户信息（userPageData.basicInfo 有 nickname/redId 等）
  emit('loading', 0, '正在读取用户信息...', 22);
  const userInfoRaw = await execJS(win, `(function(){
    try {
      var s = window.__INITIAL_STATE__;
      function unwrap(v){ return (v && typeof v === 'object' && v._value !== undefined) ? v._value : v; }
      var u = unwrap(s.user) || {};
      var upd = unwrap(u.userPageData) || {};
      var bi = unwrap(upd.basicInfo) || {};
      return JSON.stringify({ basicInfo: bi, userId: bi.userId || '' , pathUserId: ${JSON.stringify(userId)} });
    } catch(e) { return JSON.stringify({ error: e.message }); }
  })();`, 10000, '{"error":"读取用户信息超时"}');
  const uinfo = JSON.parse(userInfoRaw);
  // basicInfo 没有 userId 字段（只有 nickname/redId），用 URL 路径段作 user_id
  const targetUserId = uinfo.userId || uinfo.pathUserId || userId;
  const basicInfo = uinfo.basicInfo || {};

  // API 分页循环（页数限制与主页下载一致：5/10/20/50/100 页，999=翻到没有更多为止）
  const allNotes = [];
  const seen = new Set();
  let cursor = '';
  let page = 0;
  const pageLimit = Math.min(Math.max(Number(maxPages) || 999, 1), 999);
  const MAX_PAGES = pageLimit;
  const MAX_NOTES = pageLimit >= 999 ? 100000 : pageLimit * 30;
  // 记录本次抓取是否完整：true=翻到没有更多了，false=因页数/网络等原因提前停止（数量可能不全）
  let truncated = false;
  let stopReason = '';

  // 单页请求超时（dJ 请求偶发挂起，不带超时会让整个抓取永久卡住）
  const PAGE_TIMEOUT = 20000;
  // 翻页间隔：高频翻页会被小红书限流（HTTPServerError / 提前 has_more=false），慢速抓取更稳
  const PAGE_INTERVAL = 600;

  // 请求一页 user_posted（3 次退避重试），并把返回的新笔记去重合并进 allNotes
  // 返回 { hasMore, nextCursor, added }；彻底失败返回 { error }
  const fetchPage = async (pg, cur) => {
    const p = {
      num: 30,
      cursor: cur,
      user_id: targetUserId,
      image_formats: 'jpg,webp,avif',
    };
    if (xsecToken) {
      p.xsec_token = xsecToken;
      p.xsec_source = 'pc_feed';
    }
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // 退避等待：第 2 次前等 1s，第 3 次前等 2s（限流是瞬时的，等一会通常能恢复）
        const wait = attempt === 1 ? 1000 : 2000;
        console.warn('[XhsProfile] 第' + pg + '页第' + (attempt + 1) + '次请求前等待', wait, 'ms');
        await sleep(wait);
        // 第 2 次重试仍失败：可能是页面 webpack 状态异常（SPA 导航/风控跳转清掉了
        // webpackChunkxhs_pc_web），重载主页恢复 runtime 再试。
        if (attempt === 2 && lastProfileUrl) {
          console.warn('[XhsProfile] 第' + pg + '页重试前重载主页恢复 webpack...');
          await loadURLWithTimeout(win, lastProfileUrl, 15000).catch(() => {});
          await waitReady(win, 6000);
          await ensureWebpackReady(win, 6000).catch(() => {});
        }
      }
      try {
        const resp = await Promise.race([
          callViaWebpack(win, 'get', '/api/sns/web/v1/user_posted', p),
          new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时(' + (PAGE_TIMEOUT / 1000) + 's)')), PAGE_TIMEOUT)),
        ]);
        const notes = (resp && resp.notes) || [];
        let added = 0;
        for (const n of notes) {
          // 兼容三种 id 字段命名：noteId(驼峰,user_posted) / note_id(下划线) / id
          const id = n.noteId || n.note_id || n.id;
          if (id && !seen.has(id)) { seen.add(id); allNotes.push(n); added++; }
        }
        const hasMore = resp && (resp.hasMore !== undefined ? resp.hasMore : resp.has_more);
        const nextCursor = (resp && (resp.cursor || resp.nextCursor || resp.next_cursor)) || '';
        return { hasMore, nextCursor, added };
      } catch (e) {
        lastErr = e.message;
        console.warn('[XhsProfile] 第' + pg + '页第' + (attempt + 1) + '次请求失败:', e.message.slice(0, 120));
      }
    }
    return { error: lastErr };
  };

  emit('first-screen', 0, '正在获取作品列表（第 1 页）...', 28);
  while (page < MAX_PAGES) {
    page++;
    // 每页调用前先更新文案，让用户知道正在抓第几页（避免 API 等待期间文案不动）
    emit('scrolling', allNotes.length, `正在获取第 ${page} 页... 已累计 ${allNotes.length} 条`, page === 1 ? 28 : 30 + Math.min(50, page * 3));

    const r = await fetchPage(page, cursor);
    if (r.error) {
      // 首页就失败：明确报错；翻页中途失败：保留已抓到的，标记为不完整
      if (page === 1) {
        throw new Error('获取作品列表失败: ' + r.error + '。可能登录态失效或触发风控，请重新登录小红书后重试。');
      }
      truncated = true;
      stopReason = '网络错误: ' + r.error;
      console.warn('[XhsProfile] 第' + page + '页失败，终止翻页:', r.error);
      break;
    }

    console.log('[XhsProfile] 第', page, '页: 新增', r.added, '累计', allNotes.length, 'has_more=', r.hasMore, 'cursor=', r.nextCursor ? '(有)' : '(空)');
    // 每页返回后立刻更新累计条数 + 估算进度（每页约占剩余区间 8%，封顶 85%）
    const pagePct = 30 + Math.min(55, page * 8 + allNotes.length);
    emit('scrolling', allNotes.length, `已获取第 ${page} 页，累计 ${allNotes.length} 条${r.hasMore ? '，继续获取...' : ''}`, pagePct);

    // 终止判定：has_more=false 时复核。小红书高频翻页会误报 has_more=false（限流假阴性），
    // 若本页是满页(30条)则高度可疑--真到底时最后一页通常不满 30 条。
    // 多次退避复核（间隔递增 2s/4s/8s），全部确认真到底才退出；复核有数据则继续翻页。
    // 关键：复核"有数据"的判定不只看 has_more，还看是否返回了新笔记（added>0）--
    // 限流时 API 会谎报 has_more=false 但 cursor 变了且带了新笔记，这种必须救回。
    if (!r.hasMore || !r.nextCursor) {
      const suspicious = r.added >= 30; // 满页 + has_more=false -> 限流假阴性嫌疑
      let confirmedComplete = true;
      const confirmAttempts = suspicious ? 4 : 1;
      for (let ci = 0; ci < confirmAttempts; ci++) {
        if (ci > 0) {
          const wait = ci === 1 ? 2000 : (ci === 2 ? 4000 : 8000);
          console.warn('[XhsProfile] 第' + page + '页 has_more=false 但本页满页，第' + (ci + 1) + '次复核前等待', wait, 'ms（疑似限流假阴性）');
          await sleep(wait);
        }
        const confirm = await fetchPage(page, cursor);
        if (confirm.error) {
          console.warn('[XhsProfile] 第' + page + '页第' + (ci + 1) + '次复核请求失败:', confirm.error.slice(0, 80));
          continue; // 网络错误，继续下一次重试
        }
        // 复核"还有数据"的判定：cursor 变了 OR 返回了新笔记 OR has_more=true
        const hasNewData = (confirm.nextCursor && confirm.nextCursor !== cursor) || (confirm.added > 0) || confirm.hasMore;
        if (hasNewData) {
          cursor = confirm.nextCursor || cursor;
          confirmedComplete = false;
          console.warn('[XhsProfile] 第' + page + '页第' + (ci + 1) + '次复核救回：added=' + confirm.added + ' hasMore=' + confirm.hasMore + ' cursorChanged=' + (confirm.nextCursor !== cursor) + '，继续翻页');
          break;
        }
        console.warn('[XhsProfile] 第' + page + '页第' + (ci + 1) + '次复核仍无新数据：added=' + confirm.added + ' hasMore=' + confirm.hasMore);
      }
      if (!confirmedComplete) {
        await sleep(PAGE_INTERVAL);
        continue;
      }
      // 确认真到底（或复核也失败）：
      // 若本页满页且累计是 30 的整数倍，几乎可断定是限流假阴性--标记 truncated 让用户看到警告
      if (suspicious && allNotes.length > 0 && allNotes.length % 30 === 0) {
        truncated = true;
        stopReason = '疑似限流提前到底（本页满页但 has_more=false，可能未抓完）';
        console.warn('[XhsProfile] 第' + page + '页满页但 has_more=false，累计', allNotes.length, '为 30 整数倍，标记 truncated');
      } else {
        stopReason = 'complete';
      }
      break;
    }
    if (allNotes.length >= MAX_NOTES) {
      truncated = true;
      stopReason = '达到条数上限';
      break;
    }
    cursor = r.nextCursor;
    // 慢速翻页：降低请求频率，减少被小红书风控/限流的概率
    await sleep(PAGE_INTERVAL);
  }
  // 循环因达到页数上限而自然结束，且上一页 has_more 仍为 true：数量被页数限制截断
  if (stopReason === '') {
    truncated = true;
    stopReason = '达到页数上限(' + MAX_PAGES + '页)';
  }

  const notes = allNotes.map(normalizeNote);
  console.log('[XhsProfile] 抓取完成：API', allNotes.length, '-> 去重后', notes.length, '条');
  emit('done', notes.length, `抓取完成，共 ${notes.length} 条作品`, 100);

  if (notes.length === 0) {
    throw new Error('未能抓取到任何作品。可能原因：1) 登录态失效，请重新登录小红书；2) 该主页无公开作品；3) 触发了风控，请稍后再试或更换链接重试。');
  }

  // 用户信息：优先用 basicInfo，其次用第一条作品的 author
  const firstNote = notes[0];
  const userInfo = (basicInfo.nickname || firstNote.author.name) ? {
    nickname: basicInfo.nickname || firstNote.author.name,
    uid: targetUserId,
    avatar: (basicInfo.imageb || basicInfo.images || firstNote.author.avatar) || '',
    redId: basicInfo.redId || '',
    desc: basicInfo.desc || '',
  } : {
    nickname: '',
    uid: targetUserId,
    avatar: '',
    redId: '',
    desc: '',
  };

  return { user: userInfo, notes, truncated, fetchedPages: page, stopReason };
}

/**
 * 登录态失效信号识别：根据异常信息 / 窗口当前地址判断是否属于登录态失效，
 * 返回可读的失效原因描述；非失效返回空串（调用方保留原始错误）。
 *
 * 小红书登录态失效的几种表现（feed/user_posted 接口）：
 *   - dJ 返回 HTTP 401（未授权）
 *   - dJ 返回空响应 resp=null（页面被风控跳转，常见于登录失效后被重定向）
 *   - 隐藏窗口当前地址落在登录页 / 风控错误页（website-login / /error）
 *
 * 注意：业务码 300031 不在此列——E2E 实测它更多是「xsec_token 缺失/笔记不可见」
 * （feed 接口 body 不带 xsec_token 必报 300031），不能当作登录失效。
 */
function loginFailureHint(err, win) {
  const msg = err && err.message ? String(err.message) : '';
  // HTTP 401 / 403 等授权错误（callViaWebpack 会把状态拼进错误信息，形如 "(HTTP 401)" / "(resp.status=401)"）
  if (/HTTP\s*40[13]|status=40[13]|statusCode=40[13]|errCode=40[13]|resp\.status=40[13]/.test(msg)) {
    return '接口返回未授权（HTTP 401/403），登录态已失效';
  }
  // dJ 空响应：页面被风控跳转
  if (/resp=null|dJ 返回空响应/.test(msg)) {
    return '页面被风控跳转，登录态可能已失效';
  }
  // 接口业务码 300012 / 300015 等：小红书登录态失效的业务码（不同于 300031 的 token 缺失）
  // 300012 = 未登录 / 300015 = 登录态过期
  if (/code=300012|code=300015|\b300012\b|\b300015\b/.test(msg)) {
    return '接口返回登录态失效（业务码 300012/300015）';
  }
  // 窗口当前地址落在登录/风控页
  try {
    const u = win && win.webContents ? win.webContents.getURL() : '';
    if (u && (/website-login|\/login|passport|login\/error/.test(u) || u.indexOf('/error') !== -1)) {
      return '页面被重定向到登录页，登录态已失效';
    }
  } catch (e) { /* ignore */ }
  return '';
}

/**
 * 检查小红书登录态是否就绪（DB 里存的 cookie 或隐藏窗口分区会话，任一有 web_session 即算）。
 * 供 fetchNoteDetail 做快速预检：cookie 彻底丢失/从未登录时直接给明确提示，
 * 不浪费加载页面 + 调接口的时间。
 */
async function checkLoginReady() {
  const cs = db.getKV('cookie_xiaohongshu', '') || '';
  if (/(?:^|;\s*)web_session=[^;]+/.test(cs)) return true;
  try {
    const ses = require('electron').session.fromPartition('persist:xiaohongshu');
    const list = await ses.cookies.get({ name: 'web_session' }).catch(() => []);
    return list.some(c => c && String(c.value || '').length > 0);
  } catch (e) {
    return false;
  }
}

/**
 * 获取单条笔记详情（含视频流/图集 URL）。
 *
 * 通过页面内部 dJ 调 POST /api/sns/web/v1/feed 接口，dJ 会自动补 XYS_ 签名。
 * 比老的"加载详情页 SSR"方案快 10-20 倍（~300ms/条 vs 5-10s/条）：
 *   - SSR 方案每条都要 loadURL 整个详情页 + 等首屏渲染
 *   - feed API 只是一次带签名的 HTTP POST，复用已初始化的 dJ 实例
 *
 * 前提：隐藏窗口已加载过小红书页面（webpack runtime 已初始化）。
 *       fetchUserNotes 会完成首次加载；若单独调用，ensureWebpackReady 会兜底等待。
 *
 * @param {Object|string} param - { noteId, xsecToken } 或直接传 noteId 字符串
 * @returns noteCard 原始结构（feed API 返回下划线命名，parseNoteCard 已兼容）
 */
async function fetchNoteDetail(param) {
  const noteId = typeof param === 'string' ? param : (param && param.noteId);
  const xsecToken = typeof param === 'string' ? '' : (param && param.xsecToken) || '';
  if (!noteId) throw new Error('缺少 noteId');

  // 登录态快速预检：feed 详情接口需要登录（web_session）。cookie 彻底缺失时
  // 直接给明确提示，避免加载页面 + 重试 3 次后才报一堆 300031。
  const loginReady = await checkLoginReady();
  if (!loginReady) {
    throw new Error('小红书未登录（缺少 web_session 登录令牌）。请先在「小红书主页提取」页面登录后再试。');
  }

  const win = await ensureWindow();

  // 确保 webpack runtime 就绪；若窗口从未加载过主页（如新建窗口）或 SPA 导航清掉了
  // webpackChunkxhs_pc_web，则重载主页恢复（否则后续 feed 调用全部失败）。
  let ready = await ensureWebpackReady(win, 6000);
  if (!ready) {
    // 优先用 lastProfileUrl（批量场景已记录主页 URL）；没有则用笔记详情页 URL 初始化。
    // 不能用空串 loadURL（会挂起）——这就是"重试一直解析中"的根因之一。
    const initUrl = lastProfileUrl || `https://www.xiaohongshu.com/explore/${noteId}`;
    if (initUrl) {
      console.warn('[XhsProfile] webpack 未就绪，加载页面恢复:', initUrl.slice(0, 60));
      // 风控跳转（website-login/error）后 webpack 丢失：重载主页恢复。
      // 注意：不能 clearStorageData（会清掉分区里小红书种的 session cookie 如 sec_poison_id，
      // 导致下次打开应用登录态丢失）。只重新注入 DB cookie 补充缺失项（injectCookies 内部
      // 对分区已有的同名 cookie 会跳过，不会覆盖小红书页面自己种的 session cookie）。
      try {
        const ses = require('electron').session.fromPartition('persist:xiaohongshu');
        await injectCookies(ses);
      } catch (e) { console.warn('[XhsProfile] 会话刷新失败:', e.message); }
      await loadURLWithTimeout(win, initUrl, 15000).catch(() => {});
      await waitReady(win, 6000);
      // 重载后若被重定向到登录/风控页（登录态失效），立即报明确错误，不继续尝试
      const redirectHint = loginFailureHint(null, win);
      if (redirectHint) {
        throw new Error('小红书登录态失效：' + redirectHint + '。请重新登录小红书后再试。');
      }
      ready = await ensureWebpackReady(win, 6000);
    }
  }
  if (!ready) {
    throw new Error('页面接口环境未就绪，请先抓取主页后再下载');
  }

  // 调 feed API（POST）。body 必须带 xsec_token + xsec_source，否则返回 300031 业务错误。
  // callViaWebpack 内部用 dJ.post，会自动加 X-s/X-t/X-S-Common 签名。
  const body = {
    source_note_id: noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: 1 },
  };
  if (xsecToken) {
    body.xsec_token = xsecToken;
    body.xsec_source = 'pc_feed';
  }

  // 限流退避重试：批量解析时高频调用 feed 会被小红书风控（HTTP 429 / 业务码 300031 等），
  // 重试间隔 1s -> 2s -> 3s。重试前若 webpack 丢失（SPA 导航/页面重载），重载主页恢复。
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = [0, 1000, 2000, 3000][attempt] || 3000;
      console.warn('[XhsProfile] feed 第' + (attempt + 1) + '次重试前等待', wait, 'ms');
      await sleep(wait);
      // webpack 丢失（常见于 feed 调用后 SPA 导航）：重载主页恢复
      const ok2 = await ensureWebpackReady(win, 3000).catch(() => false);
      if (!ok2 && lastProfileUrl) {
        console.warn('[XhsProfile] 重试时 webpack 丢失，重载主页恢复...');
        await loadURLWithTimeout(win, lastProfileUrl, 15000).catch(() => {});
        await waitReady(win, 5000).catch(() => {});
      }
    }
    try {
      const resp = await callViaWebpack(win, 'post', '/api/sns/web/v1/feed', body);

      // feed 返回结构：{ items: [{ id, modelType, noteCard, ... }] }
      // 注意：noteCard 字段是驼峰（feed 实测），兼容下划线 note_card。
      // callViaWebpack 已拆外层 code/success/data，resp 即业务数据。
      const items = (resp && resp.items) || [];
      if (items.length === 0) {
        throw new Error('笔记不存在或已被删除');
      }
      const noteCard = items[0].noteCard || items[0].note_card;
      if (!noteCard) {
        throw new Error('笔记详情数据异常：noteCard 为空');
      }
      return noteCard;
    } catch (e) {
      lastErr = e;
      // 业务性错误（笔记删除/不存在）不重试
      if (e.message.indexOf('笔记不存在') !== -1 || e.message.indexOf('noteCard 为空') !== -1) {
        throw e;
      }
      // 登录态失效（401 / 空响应 / 被重定向到登录页）：立即停止重试，不再等 1s/2s/3s。
      // 之前这里会继续重试 3 次（每次还重载主页），导致登录失效时每个任务白白等 6s+，
      // 批量重试时 N 个任务串行下来要等很久，用户体验为"掉登录了还在那解析"。
      const loginHint = loginFailureHint(e, win);
      if (loginHint) {
        console.warn('[XhsProfile] 检测到登录态失效，立即停止重试:', loginHint);
        throw new Error('小红书登录态失效：' + loginHint + '。请重新登录小红书后再试。');
      }
      console.warn('[XhsProfile] feed 解析失败(第' + (attempt + 1) + '次):', e.message.slice(0, 120));
    }
  }
  // 3 次重试后仍失败：若属于登录态失效信号，改写为明确提示（用户看到的是
  // "登录态失效…请重新登录" 而不是一串 401 / resp=null 错误码）
  const hint = loginFailureHint(lastErr, win);
  if (hint) {
    throw new Error('小红书登录态失效：' + hint + '。请重新登录小红书后再试。');
  }
  // 业务码 300031：多为 xsec_token 缺失/失效或笔记不可见（非登录问题）。
  // 给可读提示，避免用户看到裸错误码，也不误导其去重新登录。
  if (lastErr && /300031|code=300031/.test(String(lastErr.message || ''))) {
    throw new Error('小红书接口返回权限错误(300031)：笔记可能已删除、权限受限或缺少访问令牌(xsec_token)。请重新抓取主页后重试。');
  }
  throw lastErr || new Error('feed 解析失败');
}

/**
 * 批量并发解析笔记详情（用于"点下载后后台解析"场景）。
 *
 * 3 路并发 + 批间 300ms 间隔，防风控。比串行快约 3 倍。
 * 单条失败不影响其他条，失败项返回 { ok:false, error }。
 *
 * 边解析边下载支持：每条解析完立即调用 onResolved(result, item)，
 * 调用方可以在不等待全部解析完成的情况下，逐条把任务转为真实下载任务。
 *
 * @param {Array} noteList - [{ noteId, xsecToken }]（也接受 {noteId} 字符串兼容）
 * @param {Function} [onProgress] - (done, total) 进度回调
 * @param {Function} [onResolved] - (result, item) 每条解析完成的流式回调（边解析边下载用）
 * @returns {Promise<Array>} results[]，与 noteList 等长同序：
 *          { ok:true, noteCard, item } 或 { ok:false, error, item }
 */
async function fetchNoteDetailBatch(noteList, onProgress, onResolved) {
  // 实测：feed 接口并发（3 路）极易触发小红书风控——前 3 条成功后第 4 条起被
  // 重定向到 website-login/error（webpack 清空），表现为「接口调用失败」。
  // 大批量（数百条）场景改为串行 + 每条间隔 800ms：
  //   - 串行单发显著降低风控概率
  //   - 连续失败时暂停冷却（30s），给风控窗口恢复时间
  // 串行速度：~1.2s/条（含间隔），981 条约 20 分钟，换取稳定成功率。
  const results = new Array(noteList.length);
  let done = 0;
  let consecutiveFail = 0;

  for (let i = 0; i < noteList.length; i++) {
    const item = noteList[i];
    let r;
    try {
      const nc = await fetchNoteDetail(item);
      r = { ok: true, noteCard: nc, item };
      consecutiveFail = 0;
    } catch (e) {
      r = { ok: false, error: e.message, item };
      consecutiveFail++;
      // 连续失败 5 次：大概率被风控标记，暂停 30 秒冷却
      if (consecutiveFail >= 5) {
        console.warn('[XhsProfile] 连续失败 ' + consecutiveFail + ' 次，暂停 30s 冷却（疑似风控）...');
        await sleep(30000);
        consecutiveFail = 0;
      }
    }
    results[i] = r;
    // 流式回调：每条解析完立即通知（边解析边下载）
    if (typeof onResolved === 'function') {
      try { onResolved(r, item); } catch (e) { console.warn('[XhsProfile] onResolved 回调异常:', e.message); }
    }
    done++;
    if (typeof onProgress === 'function') {
      try { onProgress(done, noteList.length); } catch (e) {}
    }
    // 条间间隔：大批量任务拉长间隔降低风控
    // 间隔已下调（原 800/400ms）：解析本身约 300ms/条，300ms 间隔下总速度约 2 条/秒，
    // 实测串行 300ms 在大批量下仍稳定（3 路并发才会触发风控重定向到登录页）。
    if (i < noteList.length - 1) {
      await sleep(noteList.length > 200 ? 400 : 250);
    }
  }
  return results;
}

/**
 * 销毁隐藏窗口（批量任务全部完成后调用）
 */
function destroy() {
  windowGeneration++;
  if (xhsWindow && !xhsWindow.isDestroyed()) {
    try { xhsWindow.destroy(); } catch (_) { /* ignore */ }
  }
  xhsWindow = null;
  windowReadyPromise = null;
}

module.exports = {
  fetchUserNotes: (...args) => enqueueOperation(() => fetchUserNotes(...args)),
  fetchNoteDetail: (...args) => enqueueOperation(() => fetchNoteDetail(...args)),
  fetchNoteDetailBatch: (...args) => enqueueOperation(() => fetchNoteDetailBatch(...args)),
  parseUserId,
  destroy,
};
