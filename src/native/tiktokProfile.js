/**
 * TikTok 主页解析（基于 tikwm.com）
 *
 * 背景：TikTok 官方接口（/api/post/item_list/）受 Slardar WAF 保护，
 * 纯 axios 请求返回空 body，无法获取指定用户的作品列表。
 * tikwm.com 提供 /api/user/info（拿 secUid）与 /api/user/posts（作品列表），
 * 但 /api/user/posts 受 Cloudflare JS 质询保护，纯 axios 返回 403。
 *
 * 方案：用一个隐藏的 BrowserWindow 加载 tikwm.com 通过 Cloudflare 质询，
 * 之后在该页面上下文内用 fetch() 调用同源 API（自动携带 cf_clearance），
 * 即可稳定拿到目标用户的真实作品列表。
 *
 * 对外暴露两个方法，签名与 DouyinAPI 对齐，便于 native-api 分发复用：
 *   - getUserProfile(uniqueId)                -> { user: {...} }
 *   - getUserVideos(secOrUnique, cursor, count) -> { aweme_list, max_cursor, has_more }
 */

const { BrowserWindow } = require('electron');

const TIKWM_ORIGIN = 'https://www.tikwm.com';

let cfWindow = null;      // 复用的隐藏窗口
let cfReadyPromise = null; // 并发去重

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 从各种输入中提取 unique_id（去掉 @、URL 包裹等）
function extractUniqueId(input) {
  if (!input) return '';
  let s = String(input).trim();

  // 完整/短链接：尝试从中提取 @用户名
  const atMatch = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (atMatch) return atMatch[1];

  // 纯 @用户名 或 用户名
  s = s.replace(/^@/, '');
  // 去掉可能的查询串
  s = s.split(/[?#/]/)[0];
  return s;
}

// 判断字符串是否为 TikTok 的 secUid（MS4w... 开头）
function isSecUid(s) {
  return typeof s === 'string' && /^MS4wLj/.test(s.trim());
}

// 创建/复用隐藏窗口，并确保已通过 Cloudflare 质询
async function ensureWindow() {
  if (cfWindow && !cfWindow.isDestroyed()) {
    return cfWindow;
  }
  if (cfReadyPromise) return cfReadyPromise;

  cfReadyPromise = (async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 允许后台窗口正常执行 JS（Cloudflare 质询依赖计时器）
        backgroundThrottling: false,
      },
    });

    // 加载首页触发 Cloudflare 质询
    await win.loadURL(`${TIKWM_ORIGIN}/`);

    // 轮询等待质询通过（最多约 45s）
    let cleared = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      let info;
      try {
        const raw = await win.webContents.executeJavaScript(
          'JSON.stringify({title:document.title,ch:!!document.querySelector("#challenge-form,#cf-challenge-running,.cf-browser-verification"),len:document.body?document.body.innerText.length:0})'
        );
        info = JSON.parse(raw);
      } catch (e) {
        info = { title: '', ch: true, len: 0 };
      }
      const challengeTitle = /just a moment|attention required|请稍候|cloudflare/i.test(info.title || '');
      if (!challengeTitle && !info.ch && info.len > 50) {
        cleared = true;
        break;
      }
    }

    if (!cleared) {
      win.destroy();
      cfWindow = null;
      cfReadyPromise = null;
      throw new Error('无法通过 tikwm 的 Cloudflare 验证，请稍后重试');
    }

    cfWindow = win;
    cfReadyPromise = null;
    // 窗口意外关闭时清空引用
    win.on('closed', () => { cfWindow = null; });
    return win;
  })();

  return cfReadyPromise;
}

// 在页面上下文内 fetch 同源 API，返回解析后的 JSON 对象
async function apiFetch(pathWithQuery) {
  let win = await ensureWindow();

  const expr = `
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(pathWithQuery)}, { headers: { 'Accept': 'application/json' } });
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          const txt = await r.text();
          return { __ok: false, status: r.status, html: txt.slice(0, 120) };
        }
        const body = await r.json();
        return { __ok: true, status: r.status, body };
      } catch (e) {
        return { __ok: false, error: e.message };
      }
    })()
  `;

  let res = await win.webContents.executeJavaScript(expr);

  // 若被 Cloudflare 拦截（返回 HTML），重建窗口重试一次
  if (!res || res.__ok !== true) {
    if (cfWindow && !cfWindow.isDestroyed()) cfWindow.destroy();
    cfWindow = null;
    cfReadyPromise = null;
    win = await ensureWindow();
    res = await win.webContents.executeJavaScript(expr);
  }

  if (!res || res.__ok !== true) {
    const detail = res && (res.error || res.html || `HTTP ${res.status}`);
    throw new Error(`tikwm 请求失败: ${detail || '未知错误'}`);
  }
  return res.body;
}

// 将 tikwm 的 posts item 映射为渲染层期望的 aweme 结构（带 isTiktok 标记）
function mapItemToAweme(item) {
  const author = item.author || {};
  // tikwm 的 play 是无水印直链；图文作品用 images 数组（元素为图片URL字符串）
  const noWmUrl = item.play || item.hdplay || item.wmplay || '';
  const uniqueId = author.unique_id || '';
  const videoId = item.video_id || item.aweme_id || '';

  const aweme = {
    isTiktok: true,
    aweme_id: videoId,
    desc: item.title || item.content_desc || '',
    // 官方 TikTok 分享链接（作为兜底解析用）
    tiktokShareUrl: uniqueId && videoId
      ? `https://www.tiktok.com/@${uniqueId}/video/${videoId}`
      : '',
    author: {
      nickname: author.nickname || uniqueId || '',
      unique_id: uniqueId,
      avatar_thumb: { url_list: author.avatar ? [author.avatar] : [] },
    },
    statistics: {
      digg_count: item.digg_count || 0,
      comment_count: item.comment_count || 0,
      play_count: item.play_count || 0,
      share_count: item.share_count || 0,
    },
    create_time: item.create_time || 0,
  };

  // 图文作品：images 为字符串数组
  if (Array.isArray(item.images) && item.images.length > 0) {
    aweme.images = item.images.map((u) => ({ url_list: [u], url: u }));
  } else {
    // 视频作品：无水印直链放入 play_addr.url_list[0]
    aweme.video = {
      play_addr: { url_list: noWmUrl ? [noWmUrl] : [] },
      duration: (item.duration || 0) * 1000,
      cover: { url_list: item.cover ? [item.cover] : [] },
    };
  }

  return aweme;
}

/**
 * 获取用户信息（返回结构对齐 douyin：{ user: {...} }）
 * @param {string} input uniqueId / @用户名 / 主页链接
 */
async function getUserProfile(input) {
  const uniqueId = extractUniqueId(input);
  if (!uniqueId) throw new Error('无法从链接中提取 TikTok 用户名');

  const body = await apiFetch(`/api/user/info?unique_id=${encodeURIComponent(uniqueId)}`);
  if (!body || body.code !== 0 || !body.data || !body.data.user) {
    throw new Error((body && body.msg) || '获取 TikTok 用户信息失败');
  }
  const u = body.data.user || {};
  const stats = body.data.stats || {};

  // 映射为渲染层 UserInfo 期望字段
  return {
    user: {
      nickname: u.nickname || u.uniqueId || uniqueId,
      unique_id: u.uniqueId || uniqueId,
      short_id: u.id || '',
      sec_uid: u.secUid || '',
      signature: u.signature || '',
      avatar_thumb: { url_list: (u.avatarThumb || u.avatarLarger || u.avatarMedium) ? [u.avatarThumb || u.avatarLarger || u.avatarMedium] : [] },
      follower_count: stats.followerCount || 0,
      aweme_count: stats.videoCount || 0,
      // 保留 uniqueId 供后续取作品列表复用（避免再解析一次）
      _tiktokUniqueId: u.uniqueId || uniqueId,
    },
  };
}

/**
 * 获取用户作品列表（返回结构对齐 douyin：{ aweme_list, max_cursor, has_more }）
 * @param {string} input   uniqueId / @用户名 / 主页链接（首页 cursor=0）
 * @param {number} cursor  tikwm 的时间戳游标（首次传 0）
 * @param {number} count   每页数量
 */
async function getUserVideos(input, cursor = 0, count = 30) {
  const uniqueId = extractUniqueId(input);
  if (!uniqueId) throw new Error('无法从链接中提取 TikTok 用户名');

  const c = Number(count) > 0 ? Number(count) : 30;
  const cur = Number(cursor) > 0 ? Number(cursor) : 0;
  const body = await apiFetch(
    `/api/user/posts?unique_id=${encodeURIComponent(uniqueId)}&count=${c}&cursor=${cur}`
  );
  if (!body || body.code !== 0 || !body.data) {
    throw new Error((body && body.msg) || '获取 TikTok 作品列表失败');
  }

  const videos = Array.isArray(body.data.videos) ? body.data.videos : [];
  return {
    aweme_list: videos.map(mapItemToAweme),
    max_cursor: body.data.cursor || 0,
    has_more: body.data.hasMore === true || body.data.hasMore === 1 ? 1 : 0,
  };
}

module.exports = { getUserProfile, getUserVideos, extractUniqueId };
