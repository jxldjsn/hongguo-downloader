/**
 * 快手主页作品列表抓取（隐藏窗口 + CDP 拦截页面自动请求）
 *
 * 背景：快手 REST API: POST https://www.kuaishou.com/rest/v/profile/feed
 *   需要 __NS_hxfalcon 签名 + kuaishou.web.api_st 登录令牌。
 *
 * 签名机制（已逆向确认）：
 *   - hxfalcon 签名引擎已完整逆向（kuaishouSign.js 可纯 Node 生成签名，
 *     feed/hot 等无需登录接口验证通过）
 *   - 但 profile/feed 额外校验签名设备指纹与 api_st 的绑定：
 *     设备指纹含 collectDeviceInfo 的 SECS.s（$encode 调用栈尾部 100 字符），
 *     纯 Node / 手动 fetch 的调用栈与页面自动请求不同 → result:50
 *   - 因此必须让「页面自身自动发起请求」（页面加载时自动触发 profile/feed），
 *     页面 sig4Adapter 用匹配的调用栈生成签名，服务器接受。
 *     用 CDP debugger 拦截 /rest/v/profile/feed 响应提取数据。
 *
 * 登录态：快手现以 kuaishou.server.webday7_st 为登录哨兵（web_st 已废弃/可选），
 *   完整登录态 = webday7_st（或 web_st）+ userId + passToken 齐全。
 *   令牌过期时 REST API 返回 result:109（需重新登录）。
 *
 * 对外暴露：
 *   - fetchProfile(profileUrl, maxPages, onProgress) -> { success, user, videos, error? }
 *   - destroy() -> 销毁隐藏窗口
 */

const { BrowserWindow, session } = require('electron');
const db = require('./database');

const HOME_URL = 'https://www.kuaishou.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let ksWindow = null;
let windowReadyPromise = null;
let operationQueue = Promise.resolve();
let windowGeneration = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从主页 URL 中提取 userId
 */
function parseUserId(url) {
  if (!url) return '';
  const s = String(url).trim();
  const m = s.match(/profile\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return s.split(/[?#/]/).filter(Boolean).pop() || '';
}

/**
 * 读取已保存的快手 cookie 字符串
 */
function getCookie() {
  return String(db.getKV('cookie_kuaishou', '') || '').trim();
}

/**
 * 创建/复用隐藏窗口（与登录窗口共享 persist:kuaishou 分区，保持会话一致）
 */
async function ensureWindow() {
  if (ksWindow && !ksWindow.isDestroyed()) return ksWindow;
  if (windowReadyPromise) return windowReadyPromise;

  const generation = windowGeneration;
  const createWindowPromise = (async () => {
  const ses = session.fromPartition('persist:kuaishou');
  // 注入 DB 完整 cookie（含 api_st），覆盖分区内可能缺失的令牌
  const cookieStr = getCookie();
  if (cookieStr) {
    for (const pair of cookieStr.split(';')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      try {
        await ses.cookies.set({
          url: `${HOME_URL}`,
          name,
          value,
          domain: '.kuaishou.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
          expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
        });
      } catch (e) {
        console.warn('[KsProfile] cookie 写入失败:', name, e.message);
      }
    }
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      session: ses,
    },
  });

  await win.webContents.setUserAgent(USER_AGENT);
  if (generation !== windowGeneration) {
    try { win.destroy(); } catch (_) { /* ignore */ }
    throw new Error('快手隐藏窗口已重置');
  }
  ksWindow = win;
  win.on('closed', () => {
    if (ksWindow === win) ksWindow = null;
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
 * 把 REST API 的 feed 对象映射成与抖音 aweme 兼容的 video 对象
 * 快手 REST feed 结构：{ photo: { photo_id, caption, cover_url, photo_url, like_count, view_count, timestamp, duration }, author: { user_id, user_name, headurl } }
 */
function normalizeFeed(feed) {
  if (!feed) return null;
  const photo = feed.photo || feed.photoObj || {};
  const author = feed.author || {};
  // 快手 REST API 字段是下划线命名
  const photoId = photo.photo_id || photo.id || '';
  const photoUrl = photo.photo_url || photo.url || '';
  const coverUrl = photo.cover_url || photo.coverUrl || '';
  const caption = photo.caption || photo.desc || '';
  const likeCount = Number(photo.like_count) || 0;
  const viewCount = Number(photo.view_count) || 0;
  const timestamp = Number(photo.timestamp) || 0;

  return {
    aweme_id: photoId,
    desc: caption,
    create_time: timestamp ? Math.floor(timestamp / 1000) : 0,
    duration: Number(photo.duration) || 0,
    author: {
      uid: author.user_id || author.id || '',
      sec_uid: author.user_id || author.id || '',
      nickname: author.user_name || author.name || '',
      avatar_thumb: (author.headurl || author.headerUrl) ? { url_list: [author.headurl || author.headerUrl] } : undefined,
    },
    statistics: {
      digg_count: likeCount,
      comment_count: 0,
      share_count: 0,
      play_count: viewCount,
    },
    video: {
      play_addr: { url_list: photoUrl ? [photoUrl] : [] },
      cover: { url_list: coverUrl ? [coverUrl] : [] },
      origin_cover: { url_list: coverUrl ? [coverUrl] : [] },
      duration: Number(photo.duration) || 0,
      width: 0,
      height: 0,
    },
    platform: 'kuaishou',
    share_url: photoId ? `https://www.kuaishou.com/short-video/${photoId}` : '',
    // 快手图集：ext_params.atlas 含图片列表
    images: extractKsImages(photo),
  };
}

/**
 * 快手图集作品：ext_params.atlas 或 atlas 字段含图片列表
 */
function extractKsImages(photo) {
  if (!photo) return null;
  const atlas = (photo.ext_params && photo.ext_params.atlas) || photo.atlas;
  if (atlas && Array.isArray(atlas.list) && atlas.list.length > 0) {
    return atlas.list.map(url => ({ url_list: [url] }));
  }
  // REST API 可能用 ext_params.atlas.cdn 或 images 字段
  if (Array.isArray(photo.images) && photo.images.length > 0) {
    return photo.images.map(url => ({ url_list: [url] }));
  }
  return null;
}

/**
 * 抓取用户主页作品列表（页面自动请求 + CDP 拦截）
 * @param {string} profileUrl 主页 URL 或 userId
 * @param {number} maxPages 最大页数（每页约 20-30 条）
 * @param {function} onProgress 进度回调
 */
async function fetchProfile(profileUrl, maxPages = 20, onProgress) {
  const userId = parseUserId(profileUrl);
  if (!userId) {
    return { success: false, error: '无法识别快手用户 ID，请输入快手主页链接' };
  }

  const cookieStr = getCookie();
  if (!cookieStr) {
    return { success: false, error: '未登录快手，请先在「登录平台账号」里登录快手账号' };
  }
  // 登录态校验：快手现以 webday7_st（或 web_st）+ userId 为登录凭据标志
  const hasSentinel = /(?:^|;\s*)kuaishou\.server\.(?:webday7_st|web_st)=/.test(cookieStr);
  const hasUserId = /(?:^|;\s*)userId=[^;]+/.test(cookieStr);
  if (!hasSentinel || !hasUserId) {
    return {
      success: false,
      error: '快手登录态不完整（缺少登录令牌）。请在「登录平台账号」重新登录快手，扫码后等待页面完全登录（出现昵称/头像）再点「确认登录并返回」',
    };
  }

  try {
    const win = await ensureWindow();
    const profileUrlFull = `${HOME_URL}profile/${userId}`;

    // 用 CDP debugger 拦截 /rest/v/profile/feed 响应
    const allVideos = [];
    const seenIds = new Set();
    let userInfo = null;
    let pcursor = '';
    let pageCount = 0;
    const pageLimit = Math.max(1, Number(maxPages) || 20);
    let needsLogin = false;

    const dbg = win.webContents.debugger;

    // feed 请求的 requestId 集合（CDP loadingFinished 时据此取响应体）
    const feedResponses = [];

    // 响应收集：用计数器替代单指针，避免「响应在等待 Promise 创建前到达」导致丢失
    let feedResponseCount = 0;
    let pendingFeedResolve = null;
    const waitNextFeedResponse = () => {
      return new Promise((resolve) => {
        const before = feedResponseCount;
        setImmediate(() => {
          if (feedResponseCount > before) resolve();
          else pendingFeedResolve = resolve;
        });
      });
    };

    // 注册 CDP 监听（先注册，再 enable，避免漏事件）
    const onDebuggerMessage = async (event, method, params) => {
      if (method === 'Network.responseReceived') {
        const url = params.response.url;
        if (url.includes('/rest/v/profile/feed')) {
          feedResponses.push({ requestId: params.requestId, url });
        }
      } else if (method === 'Network.loadingFinished') {
        const match = feedResponses.find(f => f.requestId === params.requestId);
        if (match) {
          try {
            const res = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            const body = res.body || '';
            const data = JSON.parse(body);
            if (data.result === 109) {
              needsLogin = true;
            }
            if (data.result === 1 && data.feeds) {
              for (const feed of data.feeds) {
                const v = normalizeFeed(feed);
                if (v && v.aweme_id && !seenIds.has(v.aweme_id)) {
                  seenIds.add(v.aweme_id);
                  allVideos.push(v);
                }
              }
              pcursor = data.pcursor || '';
              pageCount++;
              if (typeof onProgress === 'function') {
                try { onProgress({ page: pageCount, total: pageLimit, fetched: allVideos.length }); } catch (_) {}
              }
            }
            feedResponseCount++;
            if (pendingFeedResolve) {
              const r = pendingFeedResolve;
              pendingFeedResolve = null;
              r();
            }
          } catch (e) {
            console.warn('[KsProfile] 解析 feed 响应失败:', e.message);
          }
        }
      }
    };
    dbg.on('message', onDebuggerMessage);

    let attachedHere = false;
    try {
    // attach + Network.enable（都有超时保护）
    try {
      if (!dbg.isAttached()) {
        dbg.attach('1.3');
        attachedHere = true;
      }
    } catch (e) {
      console.warn('[KsProfile] debugger attach:', e.message);
    }
    await Promise.race([dbg.sendCommand('Network.enable').catch(() => {}), sleep(3000)]).catch(() => {});

    // 加载用户主页（页面自动请求 profile/feed）
    console.log('[KsProfile] 加载快手主页:', profileUrlFull);
    await Promise.race([
      win.loadURL(profileUrlFull).catch(() => {}),
      sleep(15000),
    ]);
    await sleep(3000);
    console.log('[KsProfile] 页面已加载，等待作品接口响应...');

    // 等待首屏 feed 响应（最多 8 秒；无响应视为登录态/风控问题）
    await Promise.race([waitNextFeedResponse(), sleep(8000)]);

    if (needsLogin || (pageCount === 0 && allVideos.length === 0)) {
      return {
        success: false,
        error: needsLogin
          ? '快手登录态已失效（服务器判定当前登录令牌无效，result:109）。请在「登录平台账号」重新登录快手：扫码后等待页面完全跳转、右上角出现昵称/头像后再点「确认登录并返回」'
          : '未获取到快手作品（可能登录态不完整或该用户无公开作品）。请确认已在「登录平台账号」完整登录快手',
      };
    }

    // 滚动触发翻页，每页等待响应
    for (let i = 0; i < pageLimit; i++) {
      if (pcursor === 'no_more' || pcursor === null) break;
      await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
      await Promise.race([waitNextFeedResponse(), sleep(4000)]);
      if (typeof onProgress === 'function') {
        try { onProgress({ page: pageCount, total: pageLimit, fetched: allVideos.length }); } catch (_) {}
      }
      if (pageCount === 0 || (i > 0 && allVideos.length === 0)) break;
      await sleep(800);
    }

    // 从页面提取用户信息（DOM 或 INIT_STATE）
    try {
      userInfo = await win.webContents.executeJavaScript(`(function(){
        const nameEl = document.querySelector('[class*="user-name"], [class*="username"], [class*="nickname"]');
        const avatarEl = document.querySelector('[class*="avatar"] img, [class*="header"] img');
        return {
          sec_user_id: ${JSON.stringify(userId)},
          nickname: nameEl ? nameEl.textContent.trim() : '快手用户',
          avatar_thumb: avatarEl && avatarEl.src ? { url_list: [avatarEl.src] } : undefined,
          platform: 'kuaishou',
        };
      })()`);
    } catch (e) {
      userInfo = { sec_user_id: userId, nickname: '快手用户', platform: 'kuaishou' };
    }

    if (allVideos.length === 0) {
      return {
        success: false,
        error: needsLogin
          ? '快手登录态已失效，请重新登录快手'
          : '未获取到快手作品。可能是该用户无公开作品，或登录态不完整（服务器判定当前登录令牌无效）',
      };
    }

    return { success: true, user: userInfo, videos: allVideos };
    } finally {
      try { dbg.removeListener('message', onDebuggerMessage); } catch (_) { /* ignore */ }
      if (pendingFeedResolve) {
        const resolvePending = pendingFeedResolve;
        pendingFeedResolve = null;
        resolvePending();
      }
      try { if (attachedHere && dbg.isAttached()) dbg.detach(); } catch (_) { /* ignore */ }
    }
  } catch (error) {
    console.error('[KsProfile] 抓取失败:', error.message);
    return { success: false, error: error.message || '快手主页抓取失败' };
  }
}

/**
 * 销毁隐藏窗口
 */
function destroy() {
  windowGeneration++;
  if (ksWindow && !ksWindow.isDestroyed()) {
    try { ksWindow.destroy(); } catch (_) {}
  }
  ksWindow = null;
  windowReadyPromise = null;
}

module.exports = {
  fetchProfile: (...args) => enqueueOperation(() => fetchProfile(...args)),
  parseUserId,
  destroy,
};
