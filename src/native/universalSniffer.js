/**
 * 通用网页嗅探器（可见窗口 + session.webRequest 捕获媒体资源）
 *
 * 背景：通用下载器需要“输入网页 -> 嗅探页面里加载的视频/音频/图片资源”。
 *   用 CDP（debugger）在 Electron 里拦截响应不稳定（network service crash），
 *   改用 Electron 自带的 session.webRequest.onHeadersReceived：
 *   - 能拿到每个请求的响应头（content-type）与 URL，足以分类视频/音频/图片/m3u8 流；
 *   - 拿不到响应体（我们也不需要，媒体直接按 URL 下载，m3u8 交给 downloadM3u8 处理分片）；
 *   - 纯 Electron API，稳定可靠。
 *
 * 窗口设计为「可见」：用户输入网址后弹出可交互窗口，可在页面里点击播放按钮等，
 * 所有媒体请求都会被实时捕获并推送回渲染进程（网页嗅探的典型用法）。
 *
 * 对外暴露：
 *   - start(winUrl, { onResource, onStatus }) -> { ok, error? }
 *   - stop()
 *   - isRunning()
 */

const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:universal-sniff';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let sniffWindow = null;
let listenerRemovers = [];
let callbacks = null;
let seenUrls = new Set();
let collected = [];
let collectedIdx = new Map(); // url -> collected 数组下标（用于类型升级）
let resourceCounts = new Map();

// 每类最多保留条数（图片站可能刷屏，限制总量）
const MAX_TOTAL = 600;
const MAX_IMAGE = 300;
const MAX_TS = 300; // .ts 分片大量出现时单独限量

function canInsertResource(type) {
  if (collected.length >= MAX_TOTAL) return false;
  if (type === 'image' && (resourceCounts.get('image') || 0) >= MAX_IMAGE) return false;
  if (type === 'm3u8_seg' && (resourceCounts.get('m3u8_seg') || 0) >= MAX_TS) return false;
  return true;
}

function countResource(type, delta) {
  const next = Math.max(0, (resourceCounts.get(type) || 0) + delta);
  resourceCounts.set(type, next);
}

function resetState() {
  seenUrls = new Set();
  collected = [];
  collectedIdx = new Map();
  resourceCounts = new Map();
}

/**
 * 根据 URL + content-type 判断资源类型
 * @returns {string} video | audio | image | m3u8 | dash | m3u8_seg | video_dash | audio_dash | other
 *   video_dash / audio_dash：DASH 分离流的视频轨 / 音频轨（.m4s，靠响应头 content-type 区分）
 */
function classify(url, contentType) {
  const u = (url || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();
  // 埋点/统计/日志请求：一律忽略（data.bilibili.com/log、各类 /log/、/report、/spi 等）
  if (/(\/log\/web|\/log\/|\/spi\/|\/report|beacon|\/pv\?|h5log|clog)/.test(u)) return 'other';
  if (/\.ts($|\?)/.test(u)) return 'm3u8_seg';
  if (/\.mpd($|\?)/.test(u) || ct.includes('dash+xml')) return 'dash';
  if (/\.m3u8($|\?)/.test(u) || ct.includes('mpegurl')) return 'm3u8';
  if (ct.startsWith('video/')) return /\.m4s($|\?)/.test(u) ? 'video_dash' : 'video';
  if (ct.startsWith('audio/')) return /\.m4s($|\?)/.test(u) ? 'audio_dash' : 'audio';
  if (ct.startsWith('image/')) return 'image';
  // 无响应头时按扩展名兜底
  if (/\.(mp4|webm|ogv|mov|flv|m4v)(\?|$)/.test(u)) return 'video';
  if (/\.(m4a|mp3|ogg|wav|flac|aac)(\?|$)/.test(u)) return 'audio';
  if (/\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|$)/.test(u)) return 'image';
  if (/\.(ts|m4s|f4f|f4m)(\?|$)/.test(u)) return 'm3u8_seg';
  return 'other';
}

function pushResource(res) {
  if (!callbacks || typeof callbacks.onResource !== 'function') return;
  try { callbacks.onResource(res); } catch (_) {}
}

/**
 * 记录一条资源（去重 + 限流）
 * 无响应头（onBeforeRequest 阶段）时，m4s/ts 等分片不抢先记录，
 * 等 onHeadersReceived 拿到 content-type 再精确分类（video_dash/audio_dash）。
 */
function record(details, contentType) {
  const url = details.url || '';
  if (!url || !/^https?:/i.test(url)) return;

  const type = classify(url, contentType);
  if (type === 'other') return;
  // 无响应头时：m4s/ts 分片先按扩展名兜底记录（防 onHeadersReceived 未触发而漏掉），
  // 后续有响应头会自动升级为更精确的类型（video_dash/audio_dash）
  const pending = !contentType && (type === 'm3u8_seg' || type === 'video_dash' || type === 'audio_dash');
  if (pending && !seenUrls.has(url)) {
    if (!canInsertResource('m3u8_seg')) return;
    seenUrls.add(url);
    const res = {
      url,
      type: 'm3u8_seg',   // 中性兜底：等待升级
      contentType: '',
      size: 0,
      pageUrl: sniffWindow ? sniffWindow.webContents.getURL() : '',
    };
    collected.push(res);
    collectedIdx.set(url, collected.length - 1);
    countResource(res.type, 1);
    pushResource(res);
    return;
  }

  // 已见过：若之前按 m3u8_seg 粗分类记录，现在用响应头升级为更精确的类型
  if (seenUrls.has(url)) {
    const idx = collectedIdx.get(url);
    if (idx !== undefined && collected[idx] && collected[idx].type === 'm3u8_seg' && type !== 'm3u8_seg') {
      countResource(collected[idx].type, -1);
      collected[idx].type = type;
      collected[idx].contentType = contentType || collected[idx].contentType;
      countResource(type, 1);
      pushResource(collected[idx]);
    }
    return;
  }
  if (!canInsertResource(type)) return;

  seenUrls.add(url);
  const res = {
    url,
    type,
    contentType: contentType || '',
    // 资源大小：只有部分响应头带 content-length
    size: Number(details.responseHeaders && (details.responseHeaders['content-length'] || details.responseHeaders['Content-Length'])) || 0,
    // 下载时用页面 URL 当 Referer（防盗链）
    pageUrl: sniffWindow ? sniffWindow.webContents.getURL() : '',
  };
  collected.push(res);
  collectedIdx.set(url, collected.length - 1);
  countResource(type, 1);
  pushResource(res);
}

function installListeners(ses) {
  const onHeaders = (details, callback) => {
    const ct = (details.responseHeaders && (details.responseHeaders['content-type'] || details.responseHeaders['Content-Type']))
      ? String(details.responseHeaders['content-type'] || details.responseHeaders['Content-Type']) : '';
    record(details, ct);
    callback({ responseHeaders: details.responseHeaders });
  };
  // 有些请求（如 m3u8 主索引、预加载资源）可能没有响应头到达，但 URL 本身就是媒体
  const onRequest = (details, callback) => {
    record(details, '');
    callback({});
  };
  ses.webRequest.onHeadersReceived(onHeaders);
  ses.webRequest.onBeforeRequest(onRequest);
  listenerRemovers = [
    () => { try { ses.webRequest.onHeadersReceived(null); } catch (_) {} },
    () => { try { ses.webRequest.onBeforeRequest(null); } catch (_) {} },
  ];
}

/**
 * 打开嗅探窗口并开始捕获页面媒体资源
 * @param {string} winUrl 要嗅探的网页地址
 * @param {object} cbs { onResource(res), onStatus(text), onWindowClosed() }
 */
function start(winUrl, cbs = {}) {
  if (sniffWindow && !sniffWindow.isDestroyed()) {
    return { ok: true, already: true };
  }
  const url = String(winUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: '请输入以 http(s):// 开头的完整网址' };
  }

  resetState();
  callbacks = cbs;

  const ses = session.fromPartition(PARTITION);
  installListeners(ses);

  sniffWindow = new BrowserWindow({
    show: true,
    width: 1150,
    height: 780,
    title: '网页嗅探',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
      backgroundThrottling: false,
      // 允许页面无用户手势自动播放（有声音播放会加载 DASH 音视频两轨，嗅探更全）
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  sniffWindow.setUserAgent?.(UA);
  sniffWindow.webContents.setUserAgent(UA);

  sniffWindow.on('closed', () => {
    sniffWindow = null;
    listenerRemovers.forEach((fn) => { try { fn(); } catch (_) {} });
    listenerRemovers = [];
    if (callbacks && typeof callbacks.onWindowClosed === 'function') {
      try { callbacks.onWindowClosed(); } catch (_) {}
    }
    callbacks = null;
  });

  if (callbacks && typeof callbacks.onStatus === 'function') {
    try { callbacks.onStatus('正在加载页面，开始嗅探媒体资源…'); } catch (_) {}
  }
  sniffWindow.loadURL(url).catch(() => {
    // 页面加载失败不阻断：部分站点重定向/证书异常，仍可捕获已发出的请求
  });

  // 页面加载完成后尝试自动触发播放：很多播放器（如 B 站 DASH）需要播放才开始加载
  // 音频轨/视频轨，自动播放可触发完整流加载，让嗅探更全。
  // SPA 内部跳转不触发 did-finish-load，这里用延时轮询触发 video 播放。
  sniffWindow.webContents.on('did-finish-load', () => {
    for (const delay of [4000, 9000, 15000]) {
      setTimeout(() => {
        try {
          sniffWindow.webContents.executeJavaScript(`(() => {
            const els = document.querySelectorAll('video, audio');
            if (!els.length) return;
            els.forEach((el) => {
              try {
                const p = el.play();
                if (p && p.catch) p.catch(() => { try { el.muted = true; el.play().catch(() => {}); } catch (e) {} });
              } catch (e) { try { el.muted = true; el.play().catch(() => {}); } catch (e2) {} }
            });
          })()`).catch(() => {});
        } catch (_) { /* ignore */ }
      }, delay);
    }
  });

  return { ok: true };
}

function stop() {
  if (sniffWindow && !sniffWindow.isDestroyed()) {
    sniffWindow.close();
  }
  sniffWindow = null;
  return true;
}

function isRunning() {
  return !!(sniffWindow && !sniffWindow.isDestroyed());
}

module.exports = { start, stop, isRunning };
