/**
 * B 站（哔哩哔哩）用户投稿作品列表抓取（纯 HTTP + Wbi 签名）
 *
 * 背景：B 站用户投稿接口为
 *   GET https://api.bilibili.com/x/space/wbi/arc/search?mid=xxx&pn=N&ps=40&order=pubdate
 *   该接口要求 Wbi 签名（img_key+sub_key 混排表 + MD5 w_rid），密钥来自
 *   GET https://api.bilibili.com/x/web-interface/nav 的 wbi_img（未登录也返回）。
 *
 * 风控要点（参考开源项目 DownKyi）：
 *   - 未登录请求必须附带 dm_img_str / dm_img_list / dm_cover_img_str / dm_img_inter 四个
 *     「风控水印」参数，否则会被 -352 拦截；
 *   - 首次访问需先拿 buvid3/buvid4 cookie（访问 www.bilibili.com 由 set-cookie 下发）；
 *   - 命中 -412/-352 时刷新 buvid 并重试。
 *
 * 列表本身无需登录；登录 cookie（SESSDATA）仅用于下载高清（1080p+）流，由下载侧传入 yt-dlp。
 *
 * 对外暴露：
 *   - fetchProfile(profileUrl, maxPages, onProgress) -> { success, user, videos, error? }
 */

const crypto = require('crypto');

// Wbi mixin key 重排表（B 站前端 Wbi 算法固定表）
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map(i => orig[i]).join('').slice(0, 32);
}

// 生成 wbi 签名后的 query 字符串（参考 B 站前端 & DownKyi WbiSign.cs）
function encWbi(params, imgKey, subKey) {
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(p).sort()
    .map(k => `${k}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + getMixinKey(imgKey + subKey)).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从主页 URL 中提取 mid（纯数字 UID）
 */
function parseMid(url) {
  if (!url) return '';
  const s = String(url).trim();
  const m = s.match(/space\.bilibili\.com\/(\d+)/);
  if (m) return m[1];
  const b = s.match(/bilibili\.com\/(\d+)/);
  if (b) return b[1];
  if (/^\d{5,12}$/.test(s)) return s;
  return '';
}

/**
 * 发起带 buvid cookie 的 GET 请求，返回 { status, body, setCookie }
 */
async function httpGet(url, cookie = '') {
  const headers = {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.bilibili.com',
  };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers, redirect: 'follow' });
  let setCookie = [];
  try { setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; } catch (_) {}
  return { status: res.status, body: await res.text(), setCookie };
}

/**
 * 获取 buvid3/buvid4 cookie + wbi keys
 */
async function initBilibili(cookieStr) {
  // 1. buvid cookie：访问首页由 set-cookie 下发
  const home = await httpGet('https://www.bilibili.com/', cookieStr);
  const setCookies = home.setCookie.map(c => c.split(';')[0]);
  const buvid3 = setCookies.find(c => c.startsWith('buvid3=')) || '';
  const buvid4 = setCookies.find(c => c.startsWith('buvid4=')) || '';
  // 登录 cookie 优先于 buvid 组合（登录态能拿到更完整的数据）
  const cookie = [cookieStr, buvid3, buvid4].filter(Boolean).join('; ');

  // 2. nav 接口拿 wbi 密钥
  const navRes = await httpGet('https://api.bilibili.com/x/web-interface/nav', cookie);
  let navData;
  try {
    navData = JSON.parse(navRes.body).data;
  } catch (_) {
    throw new Error('获取 B 站 Wbi 密钥失败（nav 接口异常）');
  }
  if (!navData || !navData.wbi_img || !navData.wbi_img.img_url) {
    throw new Error('获取 B 站 Wbi 密钥失败');
  }
  const imgKey = navData.wbi_img.img_url.slice(navData.wbi_img.img_url.lastIndexOf('/') + 1).split('.')[0];
  const subKey = navData.wbi_img.sub_url.slice(navData.wbi_img.sub_url.lastIndexOf('/') + 1).split('.')[0];

  return {
    cookie,
    imgKey,
    subKey,
    // 未登录时 isLogin=false；登录时返回当前登录用户名
    loginName: navData.isLogin ? (navData.uname || '') : '',
  };
}

/**
 * 抓一页 arc/search
 */
async function fetchPage(mid, pn, ps, imgKey, subKey, cookie) {
  const params = {
    mid,
    pn,
    ps,
    order: 'pubdate',
    // 风控水印参数（未登录必须携带，否则 -352）
    dm_img_str: 'V2ViR0wgMS',
    dm_img_list: '[]',
    dm_cover_img_str: 'QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgR1RYIDk4MCBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFyR29vZ2xlIEluYy4gKE5WSURJQS',
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  };
  const qs = encWbi(params, imgKey, subKey);
  const url = `https://api.bilibili.com/x/space/wbi/arc/search?${qs}`;
  const res = await httpGet(url, cookie);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return { risk: true };
  }
  if (json.code === -412 || json.code === -352 || json.code === -403) {
    return { risk: true, code: json.code };
  }
  if (json.code !== 0) {
    return { error: json.message || `接口返回 code=${json.code}` };
  }
  return { data: json.data };
}

/**
 * 抓取用户投稿作品列表（纯 HTTP + Wbi 签名，分页）
 * @param {string} profileUrl 主页 URL 或 mid
 * @param {number} maxPages 最大页数（每页 40 条）
 * @param {function} onProgress 进度回调
 */
async function fetchProfile(profileUrl, maxPages = 20, onProgress) {
  const mid = parseMid(profileUrl);
  if (!mid) {
    return { success: false, error: '无法识别 B 站用户 UID，请输入空间主页链接，如 https://space.bilibili.com/946974/video' };
  }

  try {
    // 读取已保存的 B 站登录 cookie（可选，仅用于拿更完整数据；列表不强制登录）
    let cookieStr = '';
    try {
      const db = require('./database');
      if (db) cookieStr = String(db.getKV('cookie_bilibili', '') || '').trim();
    } catch (_) { /* 独立测试环境无 db */ }

    const { cookie, imgKey, subKey, loginName } = await initBilibili(cookieStr);

    // 清晰度档位（yt-dlp 按 height 限制实现）：
    // 已登录（有 SESSDATA）可下到 1080P；未登录 B 站最多 720P 左右（1080P 需登录，下会失败）
    const isLoggedIn = !!loginName || /(?:^|;\s*)SESSDATA=[^;]+/.test(cookieStr);
    const qualityOptions = isLoggedIn
      ? [
          { label: '1080P', value: '1080' },
          { label: '720P', value: '720' },
          { label: '480P', value: '480' },
          { label: '360P', value: '360' },
        ]
      : [
          { label: '720P', value: '720' },
          { label: '480P', value: '480' },
          { label: '360P', value: '360' },
        ];

    const pageLimit = Math.max(1, Math.min(Number(maxPages) || 20, 200));
    const ps = 40;
    const allVideos = [];
    const seenBvids = new Set();
    let totalCount = 0;
    let userName = '';
    let userAvatar = '';

    for (let pn = 1; pn <= pageLimit; pn++) {
      let result = await fetchPage(mid, pn, ps, imgKey, subKey, cookie);

      // 风控：刷新 buvid 重试（最多 3 次）
      if (result && result.risk) {
        for (let retry = 0; retry < 3 && result && result.risk; retry++) {
          await sleep(1500 * (retry + 1));
          const fresh = await initBilibili(cookieStr);
          result = await fetchPage(mid, pn, ps, fresh.imgKey, fresh.subKey, fresh.cookie);
        }
      }

      if (result && result.error) {
        return { success: false, error: result.error };
      }
      if (!result || !result.data) {
        // 连续风控后仍失败
        return {
          success: false,
          error: allVideos.length > 0
            ? '部分页被 B 站风控拦截，已获取前 ' + allVideos.length + ' 条作品'
            : 'B 站接口风控拦截（-412/-352），请稍后重试',
        };
      }

      const pageData = result.data;
      const pageInfo = pageData.page || {};
      totalCount = pageInfo.count || totalCount;
      if (pageData.card) {
        const card = pageData.card;
        userName = card.name || userName;
        userAvatar = card.face || userAvatar;
      }

      const vlist = (pageData.list && pageData.list.vlist) || [];
      for (const v of vlist) {
        if (!v.bvid || seenBvids.has(v.bvid)) continue;
        seenBvids.add(v.bvid);
        allVideos.push({
          bvid: v.bvid,
          title: v.title || '',
          desc: v.title || '',
          created: v.created || 0,
          duration: v.length || '',           // "mm:ss" 字符串
          play: v.play || 0,
          comment: v.comment || 0,
          pic: v.pic || '',
          mid: v.mid || mid,
          author_name: v.author || userName,
          watch_url: `https://www.bilibili.com/video/${v.bvid}`,
          share_url: `https://www.bilibili.com/video/${v.bvid}`,
          isBilibili: true,
          qualityOptions,          // 可选清晰度档位（yt-dlp height 限制）
          isLoggedIn,              // 是否已登录 B 站（决定 1080P 是否可选）
          author: {
            mid: v.mid || mid,
            nickname: v.author || userName || 'B站用户',
          },
        });
      }

      if (typeof onProgress === 'function') {
        try {
          onProgress({ page: pn, total: pageLimit, fetched: allVideos.length, totalCount });
        } catch (_) {}
      }

      // 翻到底：已抓取数 >= 总数
      if (totalCount > 0 && allVideos.length >= totalCount) break;
      if (vlist.length === 0) break;

      await sleep(400); // 节流
    }

    if (allVideos.length === 0) {
      return {
        success: false,
        error: '未获取到该用户的投稿作品（可能该用户无公开投稿，或 UID 不正确）',
      };
    }

    return {
      success: true,
      user: {
        mid,
        uid: mid,
        nickname: userName || 'B站用户',
        name: userName || 'B站用户',
        avatar_thumb: userAvatar ? { url_list: [userAvatar] } : undefined,
        face: userAvatar,
        loginName,
        isLoggedIn,       // 是否已登录 B 站（决定 1080P 是否可选）
        platform: 'bilibili',
      },
      videos: allVideos,
    };
  } catch (error) {
    console.error('[BiliProfile] 抓取失败:', error.message);
    return { success: false, error: error.message || 'B 站主页抓取失败' };
  }
}

/**
 * 从 B 站视频 URL 或 BV 号中提取 bvid
 */
function parseBvid(urlOrBvid) {
  const s = String(urlOrBvid || '').trim();
  const m = s.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (m) return m[1];
  const b = s.match(/\b(BV[0-9A-Za-z]{10})\b/);
  if (b) return b[1];
  return '';
}

/**
 * 解析 B 站视频的完整 DASH 音视频流（纯 HTTP：view 接口拿 cid + playurl wbi 接口拿流）
 * 猫抓方案专用：不依赖浏览器播放器是否加载，任何 B 站视频都能拿到全部清晰度音视频轨。
 * @param {string} urlOrBvid 视频页 URL 或 BV 号
 * @returns {Promise<{success, bvid, title, duration, needLogin, video: [{id, label, codecs, url}], audio: [{id, label, url}]}>}
 */
async function fetchStreams(urlOrBvid) {
  const bvid = parseBvid(urlOrBvid);
  if (!bvid) {
    return { success: false, error: '无法识别 B 站视频 BV 号' };
  }
  try {
    let cookieStr = '';
    try {
      const db = require('./database');
      if (db) cookieStr = String(db.getKV('cookie_bilibili', '') || '').trim();
    } catch (_) { /* 独立测试环境无 db */ }

    const { cookie, imgKey, subKey } = await initBilibili(cookieStr);

    // 1. view 接口拿 cid + 标题
    const viewRes = await httpGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, cookie);
    const view = JSON.parse(viewRes.body);
    if (view.code !== 0) {
      return { success: false, error: `获取视频信息失败：${view.message || view.code}` };
    }
    const cid = view.data.cid;
    const title = view.data.title || '';
    const duration = view.data.duration || 0;

    // 2. playurl（wbi 签名 + fnval=16 DASH）拿完整音视频流
    const qs = encWbi({ bvid, cid, fnval: 16, qn: 80, fourk: 1 }, imgKey, subKey);
    const playRes = await httpGet(`https://api.bilibili.com/x/player/wbi/playurl?${qs}`, cookie);
    const play = JSON.parse(playRes.body);
    if (play.code !== 0) {
      return { success: false, error: `获取播放流失败：${play.message || play.code}（可能视频需要登录/会员）` };
    }
    const dash = play.data && play.data.dash;
    if (!dash || !dash.video || dash.video.length === 0) {
      return { success: false, error: '该视频无可用 DASH 流' };
    }

    // 清晰度 qn -> 中文标签
    const QN_LABELS = {
      127: '8K', 126: '杜比', 125: 'HDR', 120: '4K',
      116: '1080P60', 112: '1080P+', 80: '1080P',
      64: '720P', 32: '480P', 16: '360P',
    };
    // 视频轨：按清晰度 id 排序（高→低），同清晰度只留第一个（默认 avc 编码）
    const seen = new Set();
    const video = dash.video
      .slice()
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .filter((v) => {
        if (!v.baseUrl || seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
      })
      .map((v) => ({
        id: v.id,
        label: QN_LABELS[v.id] || `${v.id}P`,
        codecs: (v.codecs || '').split('.')[0].toUpperCase(),
        url: v.baseUrl || (v.backup_url && v.backup_url[0]) || '',
      }))
      .filter((v) => v.url);

    const audio = (dash.audio || [])
      .filter((a) => a && a.baseUrl)
      .map((a) => ({
        id: a.id,
        label: QN_LABELS[a.id] || `${a.id}`,
        url: a.baseUrl || (a.backup_url && a.backup_url[0]) || '',
      }))
      .filter((a) => a.url);

    return {
      success: true,
      bvid,
      title,
      duration,
      // 是否已登录：未登录只能拿到低清晰度（480P 及以下）
      needLogin: !video.some((v) => v.id >= 64),
      video,
      audio,
    };
  } catch (error) {
    console.error('[BiliPlay] 解析播放流失败:', error.message);
    return { success: false, error: error.message || '解析 B 站播放流失败' };
  }
}

module.exports = { fetchProfile, parseMid, fetchStreams, parseBvid };
