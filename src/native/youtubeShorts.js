/**
 * YouTube 频道 Shorts 抓取（纯 HTTP 逆向，无浏览器）
 * 移植自桌面脚本 get_youtube_shorts.py：
 *   1) 请求 https://www.youtube.com/@{handle}/shorts 页面
 *   2) 解析 ytcfg（INNERTUBE_API_KEY / client 上下文）与 ytInitialData（首屏数据）
 *   3) 递归提取 shortsLockupViewModel -> { video_id, title, views }
 *   4) 用官方 youtubei/v1/browse 接口 + continuation token 纯 HTTP 翻页
 */

const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const DEFAULT_MAX_PAGES = 20; // 默认最多翻 20 页（约 960 条）
const ALL_PAGES_LIMIT = 999;

function normalizePageLimit(maxPages) {
  if (maxPages === undefined || maxPages === null || maxPages === '') return DEFAULT_MAX_PAGES;
  const requested = Number(maxPages);
  if (!Number.isFinite(requested)) return DEFAULT_MAX_PAGES;
  if (requested === 0) return ALL_PAGES_LIMIT;
  return Math.max(1, Math.floor(requested));
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
  });
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}

// 递归提取 shortsLockupViewModel
function extractShorts(obj, out) {
  if (Array.isArray(obj)) { obj.forEach((i) => extractShorts(i, out)); return; }
  if (!obj || typeof obj !== 'object') return;
  if (obj.shortsLockupViewModel) {
    const vm = obj.shortsLockupViewModel;
    const title = (vm.overlayMetadata && vm.overlayMetadata.primaryText && vm.overlayMetadata.primaryText.content) || '';
    const views = (vm.overlayMetadata && vm.overlayMetadata.secondaryText && vm.overlayMetadata.secondaryText.content) || '';
    let videoId = '';
    const ep = vm.onTap && vm.onTap.innertubeCommand && vm.onTap.innertubeCommand.reelWatchEndpoint;
    if (ep && ep.videoId) videoId = ep.videoId;
    if (!videoId) {
      const m = String(vm.entityId || '').match(/shortVideoId-([A-Za-z0-9_-]{11})|shorts-shelf-item-([A-Za-z0-9_-]{11})/);
      if (m) videoId = m[1] || m[2];
    }
    if (videoId) out.push({ video_id: videoId, title, views });
  }
  for (const k of Object.keys(obj)) extractShorts(obj[k], out);
}

// 递归查找 continuation token
function findToken(obj) {
  if (Array.isArray(obj)) { for (const i of obj) { const r = findToken(i); if (r) return r; } return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.continuationItemRenderer && obj.continuationItemRenderer.continuationEndpoint && obj.continuationItemRenderer.continuationEndpoint.continuationCommand && obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token) {
    return obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }
  for (const k of Object.keys(obj)) { const r = findToken(obj[k]); if (r) return r; }
  return null;
}

/**
 * 抓取频道 Shorts
 * @param {string} url 频道主页地址，如 https://www.youtube.com/@iamfromkorea/shorts 或 https://www.youtube.com/@handle
 * @param {Function} [onProgress] 进度回调 ({ page, fetched })，每翻一页调用一次
 * @param {number} [maxPages=20] 最多翻页数（0/999 表示翻到底），对应「获取页数限制」
 * @returns {Promise<{success:boolean, shorts?:Array, error?:string, handle?:string}>}
 */
async function fetchChannelShorts(url, onProgress, maxPages = DEFAULT_MAX_PAGES) {
  const input = String(url || '').trim();
  const m = input.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/i);
  const handle = m ? m[1] : '';
  if (!handle) {
    return { success: false, error: '无法从链接中提取 YouTube 频道（需包含 @频道名），例如 https://www.youtube.com/@iamfromkorea' };
  }

  const pageUrl = `https://www.youtube.com/@${handle}/shorts`;
  let resp;
  try {
    resp = await get(pageUrl);
  } catch (e) {
    return { success: false, error: `请求 YouTube 失败: ${e.message}` };
  }
  if (resp.status !== 200) {
    return { success: false, error: `请求失败，状态码 ${resp.status}` };
  }

  // ytcfg：API key + client 上下文
  const cfgMatch = resp.body.match(/ytcfg\.set\(\s*(\{.*?\})\s*\)\s*;/);
  let cfg = {};
  if (cfgMatch) {
    try { cfg = JSON.parse(cfgMatch[1]); } catch (e) { /* ignore */ }
  }
  const apiKey = cfg.INNERTUBE_API_KEY || '';
  const clientCtx = (cfg.INNERTUBE_CONTEXT && cfg.INNERTUBE_CONTEXT.client) || {};
  const clientVer = cfg.INNERTUBE_CONTEXT_CLIENT_VERSION || clientCtx.clientVersion || '';
  const clientName = cfg.INNERTUBE_CONTEXT_CLIENT_NAME || 1;

  // ytInitialData：首屏数据
  let dataMatch = resp.body.match(/var ytInitialData = (\{.*?\});<\/script>/);
  if (!dataMatch) dataMatch = resp.body.match(/window\["ytInitialData"\] = (\{.*?\});/);
  if (!dataMatch) {
    return { success: false, error: '页面中未找到 ytInitialData 数据（可能被反爬拦截），请稍后重试' };
  }
  let initial;
  try {
    initial = JSON.parse(dataMatch[1]);
  } catch (e) {
    return { success: false, error: 'ytInitialData 解析失败' };
  }

  const all = [];
  const seen = new Set();
  const page1 = [];
  extractShorts(initial, page1);
  for (const s of page1) { if (!seen.has(s.video_id)) { seen.add(s.video_id); all.push(s); } }
  if (typeof onProgress === 'function') onProgress({ page: 1, fetched: all.length });

  // continuation 翻页（页数受「获取页数限制」控制；999/0 表示翻到底）
  const pageLimit = normalizePageLimit(maxPages);
  let token = findToken(initial);
  let page = 1;
  while (token && page < pageLimit) {
    page++;
    const browseUrl = 'https://www.youtube.com/youtubei/v1/browse?key=' + encodeURIComponent(apiKey);
    let pr;
    try {
      pr = await post(browseUrl, { context: { client: clientCtx }, continuation: token }, {
        'X-YouTube-Client-Name': String(clientName),
        'X-YouTube-Client-Version': clientVer,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      });
    } catch (e) {
      break; // 翻页失败不阻塞已拿到的数据
    }
    if (pr.status !== 200) break;
    let cd;
    try { cd = JSON.parse(pr.body); } catch (e) { break; }
    const fresh = [];
    extractShorts(cd, fresh);
    let added = 0;
    for (const s of fresh) { if (!seen.has(s.video_id)) { seen.add(s.video_id); all.push(s); added++; } }
    if (typeof onProgress === 'function') onProgress({ page, fetched: all.length });
    if (added === 0) break; // 无新增，翻到底了
    token = findToken(cd);
    await new Promise((r) => setTimeout(r, 500)); // 友好间隔
  }

  if (all.length === 0) {
    return { success: false, error: '该频道没有公开的 Shorts 短视频' };
  }
  // 视图数转数字（"1.1万次观看" -> 11000）
  // 补齐前端展示/下载所需字段：
  //   - desc: 弹窗列表用 video.desc 显示标题（shorts 原始只有 title）
  //   - short_url: 下载分支用 video.watch_url || video.short_url 取 yt-dlp 入口
  //   - isYoutube: 批量下载用 video.isYoutube 判断平台
  const shorts = all.map((s) => ({
    ...s,
    desc: s.title || '',
    views_num: parseViews(s.views),
    short_url: `https://www.youtube.com/shorts/${s.video_id}`,
    watch_url: `https://www.youtube.com/watch?v=${s.video_id}`,
    isYoutube: true,
  }));
  return { success: true, shorts, handle };
}

function parseViews(viewsText) {
  const s = String(viewsText || '');
  const m = s.match(/([\d.]+)\s*(万|亿)?/);
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  if (m[2] === '亿') return Math.round(n * 100000000);
  if (m[2] === '万') return Math.round(n * 10000);
  return Math.round(n);
}

module.exports = { fetchChannelShorts, parseViews, normalizePageLimit };
