const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, Notification, clipboard, safeStorage } = require('electron');

try {
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
} catch (_) {}

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { Readable, Transform } = require('stream');
const Store = require('electron-store');
const { DouyinAPI, TikTokAPI, BiliLiveAPI } = require('./src/native/apiService');
const { getCookiesFromBrowser, listAvailableBrowsers } = require('./src/native/browserCookies');
const db = require('./src/native/database');
// TikTok 主页解析（tikwm + 隐藏窗口过 Cloudflare），解决官方接口被 WAF 拦截的问题
const tiktokProfile = require('./src/native/tiktokProfile');
// YouTube 频道 Shorts 抓取（纯 HTTP 逆向，无浏览器）
const { fetchChannelShorts } = require('./src/native/youtubeShorts');
// 小红书主页批量抓取（隐藏窗口 + 拦截 user_posted 响应，绕过 x-s 签名）
const xhsProfile = require('./src/native/xhsProfile');
// 快手主页作品列表抓取（纯 HTTP 逆向 GraphQL，需登录 cookie）
const kuaishouProfile = require('./src/native/kuaishouProfile');
// B 站主页投稿作品列表抓取（纯 HTTP + Wbi 签名，无需登录）
const bilibiliProfile = require('./src/native/bilibiliProfile');
// 通用网页嗅探器（可见窗口 + webRequest 捕获媒体资源）
const universalSniffer = require('./src/native/universalSniffer');
// 小红书 note_card 解析（从单条解析器抽出，供主页批量下载复用）
const { parseNoteCard } = require('./src/native/multi-parser/parsers/xiaohongshu');

// 多平台视频解析器（移植自小视频网站解析，18个平台）
const multiParser = require('./src/native/multi-parser');
// yt-dlp Cookie 辅助（YouTube 登录态 -> Netscape 临时文件，绕开 bot 检测）
const {
  buildYoutubeCookieArgs,
  buildCookieArgs,
  cleanupCookieFile,
  cleanupCookieFiles,
  cleanupStaleCookieFiles,
} = require('./src/native/ytCookieFile');

const { createLoginStatusService, getStoredCredentialStatus } = require('./src/native/authStatus');
const { checkBilibiliLogin, checkDouyinLogin, checkXiaohongshuLogin, checkKuaishouLogin } = require('./src/native/loginProbes');
const { runDouyinDiagnostic, recordLoginEvent } = require('./src/native/douyinDiagnostic');

// 红果短剧批量下载与 CENC 解密
const hongguo = require('./src/native/hongguo');
const { createScheduler } = require('./src/native/download/scheduler');
const {
  TERMINAL,
  transitionTask,
  createTaskFinalizer,
  resetTaskForRetry,
  resetAndEnqueueTaskForRetry,
} = require('./src/native/download/taskState');
const { buildTaskPayload, validateTaskPayload } = require('./src/native/download/taskPayload');
const {
  sanitizeWindowsFilename,
  resolveInsideRoot,
  createPartPath,
  reserveUniquePath,
  createDirectoryTokenRegistry,
  writeStreamToPart,
  downloadHttpResponse,
  verifyNonEmptyFile,
} = require('./src/native/download/fileOutput');
const {
  YTDLP_OUTPUT_MARKER,
  summarizeItems,
  escapeSpreadsheetCSVCell,
  parseYtdlpOutputLine,
} = require('./src/native/download/specialDownloadResults');
const { runHongguoDecryptWorker } = require('./src/native/download/hongguoWorkerRunner');
const { runCancellableProcess, terminateProcessTree } = require('./src/native/download/processRunner');
const { buildManifestFfmpegArgs } = require('./src/native/download/manifestDownload');
const {
  isTrustedRendererUrl,
  createTrustedIpcHandler,
  validateExternalUrl,
  validateHttpUrl,
  validateString,
} = require('./src/native/security/ipcGuards');
const { createSecretStore } = require('./src/native/security/secretStore');
const downloadDirectoryTokens = createDirectoryTokenRegistry();
const reservedDownloadPaths = new Set();

function downloadPathKey(filePath) {
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) return null;
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function rememberDownloadPath(filePath) {
  const key = downloadPathKey(filePath);
  if (key) reservedDownloadPaths.add(key);
}

function releaseDownloadPath(filePath) {
  const key = downloadPathKey(filePath);
  if (key) reservedDownloadPaths.delete(key);
}

function reserveDownloadPath(desiredPath) {
  const reservedPath = reserveUniquePath(desiredPath, candidate => {
    const key = downloadPathKey(candidate);
    return fs.existsSync(candidate) || (key ? reservedDownloadPaths.has(key) : true);
  });
  rememberDownloadPath(reservedPath);
  return reservedPath;
}

function createDownloadAbortError() {
  const error = new Error('下载已取消');
  error.code = 'DOWNLOAD_ABORTED';
  return error;
}

function installTaskAbortRuntime(task) {
  const controller = new AbortController();
  const runtime = {
    controller,
    requestedTerminal: taskCancellationStatuses.get(task) || null,
    completion: null,
  };
  Object.defineProperty(task, 'runtime', {
    value: runtime,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  if (runtime.requestedTerminal || task.cancelled) controller.abort();
  return runtime;
}

function throwIfTaskAborted(task, signal) {
  if (task?.cancelled || signal?.aborted) throw createDownloadAbortError();
}

function isDownloadAbort(error, task, signal) {
  return !!(task?.cancelled
    || signal?.aborted
    || error?.code === 'DOWNLOAD_ABORTED'
    || error?.code === 'ERR_CANCELED'
    || error?.code === 'ABORT_ERR'
    || error?.name === 'AbortError'
    || axios.isCancel(error));
}

function waitForDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(createDownloadAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', aborted);
      reject(createDownloadAbortError());
    }
    if (signal) signal.addEventListener('abort', aborted, { once: true });
  });
}

function createCodedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// ffmpeg 可执行文件路径（ffmpeg-static 自带二进制，用于 B站 DASH 音视频合并）
// 注意：ffmpeg-static 返回的路径在打包后位于 app.asar 内，但 ffmpeg.exe 通过 asarUnpack
// 解包到 app.asar.unpacked。child_process.spawn 对 asar 内的 exe 不一定能透明重定向，
// 所以这里显式把路径中的 app.asar 替换为 app.asar.unpacked，确保 spawn 能找到真正的 exe。
let ffmpegPath;
try {
  let rawFfmpegPath = require('ffmpeg-static');
  if (rawFfmpegPath && app.isPackaged && rawFfmpegPath.includes('app.asar')) {
    rawFfmpegPath = rawFfmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
  ffmpegPath = rawFfmpegPath;
} catch (e) {
  console.warn('[ffmpeg-static] 未安装，B站 DASH 合并将不可用:', e.message);
  ffmpegPath = null;
}

// 开发模式检测
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const TRUSTED_RENDERER_POLICY = Object.freeze({
  packaged: app.isPackaged,
  appRoot: __dirname,
  developmentOrigin: 'http://localhost:3000',
});

// 所有 invoke 型 IPC 默认只接受主应用页面。远端登录页和 webview 无权直接调用主进程能力。
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerIpcHandler(
  channel,
  createTrustedIpcHandler(handler, TRUSTED_RENDERER_POLICY),
);

// 禁用 GPU 硬件加速。
// 背景：部分 Windows 环境（尤其集显/旧驱动/被安全软件注入时）GPU 进程会反复崩溃
// (gpu_process_host exit_code=143)，进而拖垮共享 GPU 上下文的渲染进程，表现为
// 主窗口白屏。禁用硬件加速改用软件合成，稳定性优先。
app.disableHardwareAcceleration();

// yt-dlp 可执行文件路径（用于 yt-dlp 通用下载：YouTube / Instagram / Twitter 等）
// yt-dlp.exe 放在 assets/ 下，通过 asarUnpack 解包到 app.asar.unpacked/assets/
// 这些站点的视频流多有签名加密或地区限制，普通 HTTP 请求会被 403，必须用 yt-dlp 解析
let ytDlpPath;
(function resolveYtDlpPath() {
  const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    // 开发态：项目根目录 assets/
    path.join(__dirname, 'assets', exeName),
    // 打包态：app.asar.unpacked/assets/
    app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', exeName) : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { ytDlpPath = p; break; }
    } catch (e) { /* ignore */ }
  }
  if (!ytDlpPath) {
    console.warn('[yt-dlp] 未找到 yt-dlp 可执行文件，yt-dlp 下载将不可用');
  } else {
    console.log('[yt-dlp] 路径:', ytDlpPath);
  }
})();

// yt-dlp 下载代理（境外站点在国内需走代理，默认 Clash 127.0.0.1:7897）
// 可通过环境变量 YTDL_PROXY 覆盖
const ytDlpProxy = process.env.YTDL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';


// 持久化存储（electron-store 保留用于迁移备份与启动早期 cookie 读取）
const store = new Store();
const credentialStore = createSecretStore({
  safeStorage,
  getRaw: (key) => db.getRawKV(key, undefined),
  setRaw: (key, value) => db.setRawKV(key, value),
  deleteRaw: (key) => db.deleteRawKV(key),
});
db.configureSecretStore(credentialStore);

function secretFailureResult(error) {
  const codes = new Set([
    'SECURE_STORAGE_UNAVAILABLE',
    'SECRET_ENCRYPT_FAILED',
    'SECRET_DECRYPT_FAILED',
    'SECRET_FORMAT_INVALID',
  ]);
  if (!error || !codes.has(error.code)) return null;
  return {
    success: false,
    code: error.code,
    error: error.message,
  };
}

function migrateLegacyCookieSecrets() {
  for (const key of db.listKVKeys('cookie_')) {
    // get() 会把数据库里的旧明文就地替换为 Windows 加密记录。
    db.getKV(key, '');
  }

  const legacyValues = store.store && typeof store.store === 'object' ? store.store : {};
  for (const key of Object.keys(legacyValues).filter(name => name.startsWith('cookie_'))) {
    const legacyValue = store.get(key, undefined);
    if (typeof legacyValue === 'string' && legacyValue) {
      const existing = db.getKV(key, '');
      if (!existing) db.setKV(key, legacyValue);
    }
    store.delete(key);
  }

  db.migrateMyAccountSecrets();
  db.flushNow();
}

function persistenceFailureResult(error) {
  if (!error || error.code !== 'PERSIST_FAILED') return null;
  return {
    success: false,
    code: 'PERSIST_FAILED',
    error: '数据保存失败，请检查磁盘空间或目录权限',
  };
}

// Native API instances
// buildXxxAPI 优先从 SQLite（数据真相源）读取 cookie，回退到 electron-store（启动早期 DB 未初始化时）
function readKV(key, fallback) {
  try { return db.getKV ? db.getKV(key, fallback) : fallback; } catch (_) { return fallback; }
}
function buildDouyinAPI() {
  const cookie = readKV('cookie_douyin', '');
  const settings = readKV('settings', null) || store.get('settings', {});
  return new DouyinAPI(cookie, null, {
    timeout: settings.timeout,
    maxRetry: settings.max_retry,
  });
}

// 用指定 cookie 创建临时 DouyinAPI（我的账号绑定：每个账号用自己的 cookie 请求，
// 只有登录账号自己才返回播放量 play_count）
function createDouyinAPIWithCookie(cookie) {
  const settings = readKV('settings', null) || store.get('settings', {});
  return new DouyinAPI(cookie || '', null, {
    timeout: settings.timeout,
    maxRetry: settings.max_retry,
  });
}

let douyinAPI = buildDouyinAPI();

// TikTok API 单例：走官方 API + X-Bogus 签名，用于主页下载（用户视频列表）
// 与 win-unpacked 基准完全一致：构造函数仅接受 (cookie, proxy)，超时固定 30s
function buildTiktokAPI() {
  const cookie = readKV('cookie_tiktok', '');
  return new TikTokAPI(cookie);
}

let tiktokAPI = buildTiktokAPI();

// 平台相关常量：登录 URL / cookie 域 / 登录态哨兵 cookie 名
const PLATFORM_COOKIE_CONFIG = {
  douyin: {
    loginUrl: 'https://www.douyin.com/',
    domain: '.douyin.com',
    importDomain: 'douyin.com',
    sessionCookie: 'sessionid_ss',   // 抖音登录态哨兵
    windowTitle: '抖音登录',
  },
  tiktok: {
    loginUrl: 'https://www.tiktok.com/login',
    domain: '.tiktok.com',
    importDomain: 'tiktok.com',
    sessionCookie: 'sessionid',      // TikTok 登录态哨兵
    windowTitle: 'TikTok 登录',
  },
  yuanbao: {
    loginUrl: 'https://yuanbao.tencent.com/chat',
    domain: '.tencent.com',
    importDomain: 'yuanbao.tencent.com',
    sessionCookie: 'mnekweinqgcon',  // 腾讯元宝登录态哨兵
    windowTitle: '腾讯元宝扫码登录',
  },
  xiaohongshu: {
    loginUrl: 'https://www.xiaohongshu.com/explore',
    domain: '.xiaohongshu.com',
    importDomain: 'xiaohongshu.com',
    sessionCookie: 'web_session',   // 小红书登录态哨兵
    windowTitle: '小红书登录',
  },
  kuaishou: {
    loginUrl: 'https://www.kuaishou.com/new-reco',
    domain: '.kuaishou.com',
    importDomain: 'kuaishou.com',
    sessionCookie: 'kuaishou.server.webday7_st',  // 快手登录态哨兵（web_st 已废弃，现用 webday7_st）
    windowTitle: '快手登录',
  },
  bilibili: {
    loginUrl: 'https://passport.bilibili.com/login',
    domain: '.bilibili.com',
    importDomain: 'bilibili.com',
    sessionCookie: 'SESSDATA',       // B 站登录态哨兵
    windowTitle: '哔哩哔哩登录',
  },
  youtube: {
    // Google 单点登录：accounts.google.com 扫码/输账号密码登录。登录成功后
    // .youtube.com 域会种 SID/SSID/__Secure-1PSID 等认证 cookie。
    // yt-dlp 需要这些 cookie 绕开 YouTube 的 bot 检测
    // （"Sign in to confirm you're not a bot"），见 ytCookieFile.js。
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/signin',
    domain: '.youtube.com',
    importDomain: 'youtube.com',
    sessionCookie: 'SID',            // YouTube/Google 登录态哨兵
    windowTitle: 'YouTube 登录',
  },
};

function getPlatformCookieConfig(platform) {
  return PLATFORM_COOKIE_CONFIG[platform] || PLATFORM_COOKIE_CONFIG.douyin;
}

function requireCookiePlatform(platform = 'douyin') {
  const normalized = String(platform || 'douyin').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_COOKIE_CONFIG, normalized)) {
    const error = new Error('不支持的登录平台');
    error.code = 'INVALID_PLATFORM';
    throw error;
  }
  return normalized;
}

// loginStatusService is initialized after the control panel constants.

// 控制端API配置
const CONTROL_PANEL_API_URL = store.get('control_panel_url', 'https://xsxmn.com/douyinhoutai/api/client.php');
const APP_VERSION = (app && typeof app.getVersion === 'function' && app.getVersion()) ? app.getVersion() : require('./package.json').version;

async function readLoginCredential(key) {
  const platform = String(key || '').replace(/^cookie_/, '');
  const cfg = getPlatformCookieConfig(platform);
  const dbCookie = String(db.getKV(key, '') || '').trim();
  try {
    const partition = session.fromPartition(`persist:${platform}`);
    const allCookies = await partition.cookies.get({});
    const baseDomain = cfg.domain.replace(/^\./, '').toLowerCase();
    const cookies = allCookies.filter(cookie => {
      const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
      return domain === baseDomain || domain.endsWith(`.${baseDomain}`);
    });
    const cookieString = cookies
      .filter(cookie => cookie && String(cookie.value || '').length > 0)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (cookieString) {
      const partitionStatus = getStoredCredentialStatus(platform, cookieString);
      if (partitionStatus.isLoggedIn || !dbCookie) return cookieString;
    }
  } catch (_) {
    // Cookie 分区不可读时回退到已加密持久化值，避免状态检查阻断主界面。
  }
  return dbCookie;
}

const loginStatusService = createLoginStatusService({
  readCredential: readLoginCredential,
  checkCredential: async (platform, cookieString) => {
    if (platform === 'douyin') return checkDouyinLogin(cookieString);
    if (platform === 'xiaohongshu') return checkXiaohongshuLogin(cookieString);
    if (platform === 'kuaishou') return checkKuaishouLogin(cookieString);
    if (platform === 'bilibili') return checkBilibiliLogin(cookieString);
    return null;
  },
});

const dns = require('dns');
// 强制 DNS 解析优先 IPv4。
// 背景：部分用户的网络存在 IPv6 路由黑洞（运营商分配了 IPv6 地址但实际不通），
// Node.js 默认按系统顺序优先尝试 IPv6，会导致抖音等接口 connect ETIMEDOUT 死等 10 秒。
// 设为 ipv4first 后等价于 curl 的 Happy Eyeballs 行为，优先用可用的 IPv4。
dns.setDefaultResultOrder('ipv4first');

// 控制端始终使用域名 HTTPS 和系统证书校验；网络错误只重试，不降级到不安全连接。
async function controlPanelRequest(action, { method = 'GET', data = null, retries = 3 } = {}) {
  const apiUrl = db.getKV('control_panel_url', CONTROL_PANEL_API_URL);
  const normalizedApiUrl = validateHttpUrl(apiUrl);
  const parsed = new URL(normalizedApiUrl);
  if (parsed.protocol !== 'https:') throw new Error('控制端地址必须使用 HTTPS');
  const actionValue = validateString(String(action || ''), {
    name: '控制端操作',
    minLength: 1,
    maxLength: 200,
    pattern: /^[a-z_]+(?:&[a-z_]+=[A-Za-z0-9._-]+)*$/i,
  });
  const endpoint = new URL(parsed.toString());
  endpoint.pathname = `${parsed.pathname.replace(/\/api\/[^/]+\.php.*$/, '') || ''}/api/client.php`;
  endpoint.search = '';
  endpoint.hash = '';
  const [actionName, ...queryParts] = actionValue.split('&');
  endpoint.searchParams.set('action', actionName);
  for (const part of queryParts) {
    const separator = part.indexOf('=');
    if (separator > 0) endpoint.searchParams.set(part.slice(0, separator), part.slice(separator + 1));
  }
  const headers = {
    'User-Agent': `DouyinTikTokMulti/${APP_VERSION}`,
    'Connection': 'close'
  };

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const cfg = { timeout: 12000, headers };
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        const r = await axios.post(endpoint.toString(), data, cfg);
        return r;
      }
      const r = await axios.get(endpoint.toString(), cfg);
      return r;
    } catch (err) {
      lastErr = err;
      const code = err.code || '';
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED'].includes(code);
      if (!retryable || attempt === retries) break;
      await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastErr;
}

function setupSingleInstanceLock(electronApp, getMainWindow) {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }

  electronApp.on('second-instance', () => {
    const existingWindow = getMainWindow();
    if (!existingWindow || existingWindow.isDestroyed()) return;
    if (existingWindow.isMinimized()) existingWindow.restore();
    existingWindow.show();
    existingWindow.focus();
  });

  return true;
}

let mainWindow = null;
let splashWindow = null;
setupSingleInstanceLock(app, () => mainWindow);

const TOP_LOGIN_STATUS_PLATFORMS = new Set([
  'xiaohongshu', 'douyin', 'kuaishou', 'bilibili',
]);

function notifyLoginStatusChanged(platform) {
  if (!TOP_LOGIN_STATUS_PLATFORMS.has(platform)) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('login-status-changed', { platform: platform });
}

// ===== 启动画面 =====
function createSplashScreen() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  splashWindow.loadFile('splash.html');
}

// ===== 主窗口 =====

const EXTERNAL_URL_HOSTS = Object.freeze([
  'douyin.com', '*.douyin.com', 'iesdouyin.com', '*.iesdouyin.com',
  'tiktok.com', '*.tiktok.com',
  'xiaohongshu.com', '*.xiaohongshu.com', 'xhslink.com', '*.xhslink.com',
  'kuaishou.com', '*.kuaishou.com', 'gifshow.com', '*.gifshow.com',
  'bilibili.com', '*.bilibili.com', 'b23.tv',
  'youtube.com', '*.youtube.com', 'youtu.be', 'google.com', '*.google.com',
  'weibo.com', '*.weibo.com', 'ixigua.com', '*.ixigua.com',
  'acfun.cn', '*.acfun.cn', 'huya.com', '*.huya.com',
  'pipix.com', '*.pipix.com', 'izuiyou.com', '*.izuiyou.com',
  'qq.com', '*.qq.com', 'weixin.qq.com', '*.weixin.qq.com',
  'meipai.com', '*.meipai.com', 'haokan.baidu.com', 'pearvideo.com', '*.pearvideo.com',
  'xsxmn.com', '*.xsxmn.com', 'github.com', '*.github.com',
]);
const WEBVIEW_URL_HOSTS = Object.freeze(['douyin.com', '*.douyin.com']);

async function openAllowedExternalUrl(rawUrl, allowedHosts = EXTERNAL_URL_HOSTS) {
  const safeUrl = validateExternalUrl(rawUrl, allowedHosts);
  await shell.openExternal(safeUrl);
  return safeUrl;
}

// 拦截外部协议导航（bytedance:// 等 App 唤起协议），避免系统弹「打开此链接的应用」错误。
// 页面里抖音/其他站点可能通过 location 跳转或 window.open 唤起 App 协议，
// 未拦截时 Electron 会把它交给系统（Windows 无对应应用就报错）。
function guardExternalNavigation(wc) {
  if (!wc) return;
  try {
    wc.on('will-navigate', (event, url) => {
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          event.preventDefault();
        }
      } catch (e) {
        event.preventDefault();
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      void openAllowedExternalUrl(url).catch(() => {});
      return { action: 'deny' };
    });
  } catch (e) { /* ignore */ }
}

function guardMainWindowNavigation(wc) {
  if (!wc) return;
  wc.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, TRUSTED_RENDERER_POLICY)) return;
    event.preventDefault();
    void openAllowedExternalUrl(url).catch(() => {});
  });
  wc.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url).catch(() => {});
    return { action: 'deny' };
  });
}

const permissionSessions = new WeakSet();
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    try {
      validateExternalUrl(params.src, WEBVIEW_URL_HOSTS);
      params.partition = 'persist:douyin';
    } catch (_) {
      event.preventDefault();
    }
  });

  contents.on('did-attach-webview', (_attachEvent, guest) => {
    guest.on('will-navigate', (event, url) => {
      try {
        validateExternalUrl(url, WEBVIEW_URL_HOSTS);
      } catch (_) {
        event.preventDefault();
      }
    });
    guest.setWindowOpenHandler(({ url }) => {
      void openAllowedExternalUrl(url, WEBVIEW_URL_HOSTS).catch(() => {});
      return { action: 'deny' };
    });
  });

  const targetSession = contents.session;
  if (!targetSession || permissionSessions.has(targetSession)) return;
  permissionSessions.add(targetSession);
  targetSession.setPermissionRequestHandler((_requestingContents, _permission, callback) => callback(false));
  if (typeof targetSession.setPermissionCheckHandler === 'function') {
    targetSession.setPermissionCheckHandler(() => false);
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    frame: false,
    thickFrame: true,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 允许首页「快速下载」里的内置浏览器使用 <webview> 标签
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'build', 'icon.ico')
  });

  // 拦截外部协议跳转（bytedance:// 等），避免系统弹「打开此链接的应用」
  guardMainWindowNavigation(mainWindow.webContents);

  // 禁用默认菜单栏 (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  // 本地构建产物路径（回退用）
  const localIndex = path.join(__dirname, 'dist-react', 'index.html');
  const hasLocalBuild = fs.existsSync(localIndex);

  // 加载页面失败时回退到本地构建产物，避免黑屏
  // （典型场景：以源码方式运行但 vite 开发服务器未启动）
  let fallbackTried = false;
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // -3 (ERR_ABORTED) 多为正常的重定向/取消，忽略
    if (errorCode === -3) return;
    console.error(`[Window] 页面加载失败 (${errorCode} ${errorDescription}): ${validatedURL}`);
    if (!fallbackTried && hasLocalBuild) {
      fallbackTried = true;
      console.log('[Window] 回退加载本地构建产物:', localIndex);
      mainWindow.loadFile(localIndex);
    } else if (!hasLocalBuild) {
      console.error('[Window] 未找到本地构建产物，请先执行 npm run build:react');
    }
  });

  // 加载React应用
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(localIndex);
  }

  // 渲染进程崩溃（GPU 异常 / 安全软件注入 / OOM 等）时自动重载，避免窗口白屏卡死。
  // 首次崩溃立即重载；短时间内连续崩溃则提示用户并退出，防止崩溃循环。
  let rendererCrashCount = 0;
  let rendererCrashTimer = null;
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Window] 渲染进程崩溃:', JSON.stringify(details));
    rendererCrashCount += 1;
    if (rendererCrashTimer) clearTimeout(rendererCrashTimer);
    rendererCrashTimer = setTimeout(() => { rendererCrashCount = 0; }, 60000);
    if (rendererCrashCount <= 3) {
      console.log(`[Window] 渲染进程崩溃，第 ${rendererCrashCount} 次自动重载...`);
      try {
        if (isDev) {
          mainWindow.loadURL('http://localhost:3000');
        } else {
          mainWindow.loadFile(localIndex);
        }
      } catch (e) { /* ignore */ }
    } else {
      dialog.showErrorBox(
        '渲染进程反复崩溃',
        '主窗口渲染进程在短时间内多次崩溃，应用将退出。\n\n' +
        '可能原因：\n• 显卡驱动异常或 GPU 硬件加速不稳定\n• 安全软件拦截了渲染进程\n• 系统内存不足\n\n' +
        '崩溃详情：' + JSON.stringify(details)
      );
      app.quit();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('window-state-changed', {
      isMaximized: mainWindow.isMaximized(),
    });
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== Cookie管理器 =====
class CookieManager {
  constructor() {
    this.loginWindow = null;
    this.loginPlatform = null;
  }

  async openLoginWindow(platform = 'douyin') {
    platform = requireCookiePlatform(platform);
    const cfg = getPlatformCookieConfig(platform);
    return new Promise(async (resolve, reject) => {
      const sessionName = `persist:${platform}`;
      const ses = session.fromPartition(sessionName);

      this.loginWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: cfg.windowTitle,
        webPreferences: {
          partition: sessionName,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: true,
          webSecurity: true,
          preload: path.join(__dirname, 'preload-login.js')
        },
        autoHideMenuBar: true
      });
      this.loginPlatform = platform;

      // 拦截外部协议跳转（bytedance:// 等 App 唤起），并将新窗口跳转在当前登录窗内加载
      this.loginWindow.webContents.on('will-navigate', (event, url) => {
        try {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            event.preventDefault();
          }
        } catch (e) {
          event.preventDefault();
        }
      });
      if (this.loginWindow.webContents && typeof this.loginWindow.webContents.setWindowOpenHandler === 'function') {
        this.loginWindow.webContents.setWindowOpenHandler(({ url }) => {
          try {
            const u = new URL(url);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
              if (this.loginWindow && !this.loginWindow.isDestroyed()) {
                this.loginWindow.loadURL(url);
              }
              return { action: 'deny' };
            }
          } catch (e) {}
          return { action: 'deny' };
        });
      }
      if (typeof recordLoginEvent === 'function') recordLoginEvent('window-created', { platform, url: cfg.loginUrl });

      // 统一使用正常 Chrome 139 UA 并抹除 Electron HTTP 头特征
      const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
      this.loginWindow.webContents.setUserAgent(chromeUA);

      try {
        ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
          const headers = { ...details.requestHeaders };
          headers['User-Agent'] = chromeUA;
          headers['sec-ch-ua'] = '"Google Chrome";v="139", "Chromium";v="139", "Not?A_Brand";v="24"';
          headers['sec-ch-ua-mobile'] = '?0';
          headers['sec-ch-ua-platform'] = '"Windows"';
          delete headers['X-Electron'];
          delete headers['x-electron'];
          callback({ requestHeaders: headers });
        });
      } catch (_) {}

      // 若已保存该平台 Cookie，恢复并注入会话以保持登录态；仅当没有 Cookie 时才执行全新登录清理
      const savedCookie = typeof db !== 'undefined' && db && typeof db.getKV === 'function'
        ? String(db.getKV(`cookie_${platform}`, '') || '').trim()
        : '';
      if (savedCookie) {
        await syncCookiesToSession(platform).catch(() => {});
        console.log(`[Cookie] 已恢复 ${platform} 历史登录态`);
      } else {
        try {
          await ses.clearCache().catch(() => {});
          await ses.clearStorageData({
            storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
          }).catch(() => {});
          console.log(`[Cookie] 已清理 ${platform} 分区缓存，开始全新登录`);
        } catch (e) {
          console.warn(`[Cookie] 清理 ${platform} 分区失败:`, e.message);
        }
      }

      this.loginWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        if (errorCode === -3) return;
        console.warn(`[LoginWindow] ${platform} 页面加载失败 (${errorCode} ${errorDescription}): ${validatedURL}`);
        if (platform === 'xiaohongshu' && (!validatedURL || validatedURL.indexOf('/explore') === -1)) {
          console.log('[LoginWindow] 小红书自动尝试加载 /explore 页面...');
          this.loginWindow.loadURL('https://www.xiaohongshu.com/explore').catch(() => {});
        }
      });

      this.loginWindow.loadURL(cfg.loginUrl);

      // 注入确认按钮 + 顶部地址栏 + 自动打开登录面板
      this.loginWindow.webContents.on('did-finish-load', () => {
        this.injectConfirmButton(platform);
        this.injectAddressBar();
        if (platform === 'xiaohongshu') {
          this.autoOpenXhsLoginPanel();
        } else if (platform === 'douyin') {
          this.autoOpenDouyinLoginPanel();
        }
      });

      this.loginWindow.webContents.on('did-navigate-in-page', () => {
        this.injectConfirmButton(platform);
        this.injectAddressBar();
        if (platform === 'douyin') {
          this.autoOpenDouyinLoginPanel();
        }
      });

      const btnTimer = setInterval(() => {
        if (!this.loginWindow || this.loginWindow.isDestroyed()) return;
        this.injectConfirmButton(platform);
      }, 1500);

      // 监听确认消息
      this.loginWindow.webContents.on('ipc-message', async (event, channel) => {
        if (channel === `login-confirmed-${platform}`) {
          if (typeof recordLoginEvent === 'function') recordLoginEvent('login-confirmed-received', { platform });
          try {
            const cookies = await this.waitForLoginComplete(ses, platform, 5000);
            if (typeof recordLoginEvent === 'function') {
              recordLoginEvent('login-wait-complete', {
                platform,
                count: cookies.count,
                keys: Object.keys(cookies.cookieDict || {}),
              });
            }
            clearInterval(btnTimer);
            if (this.loginWindow && !this.loginWindow.isDestroyed()) {
              this.loginWindow.close();
            }
            this.loginWindow = null;
            this.loginPlatform = null;
            resolve(cookies);
          } catch (error) {
            if (typeof recordLoginEvent === 'function') recordLoginEvent('login-confirmed-error', { platform, error: error.message });
            reject(error);
          }
        }
      });

      this.loginWindow.on('closed', async () => {
        if (typeof recordLoginEvent === 'function') recordLoginEvent('window-closed', { platform });
        clearInterval(btnTimer);
        this.loginWindow = null;
        this.loginPlatform = null;
        try {
          const cookies = await this.waitForLoginComplete(ses, platform, 2000);
          if (cookies && cookies.cookieString) {
            const isPlatformLoggedIn = (plat, cookieStr) => {
              if (plat === 'douyin') {
                return /(^|;\s*)(sessionid_ss|sessionid|sid_guard|sid_tt|passport_auth_status)=/.test(cookieStr);
              }
              if (plat === 'youtube') {
                return /(^|;\s*)__Secure-1PSID=/.test(cookieStr);
              }
              return cookieStr.indexOf(cfg.sessionCookie) !== -1;
            };
            if (isPlatformLoggedIn(platform, cookies.cookieString)) {
              console.log(`[Cookie] 关闭窗口时检测到 ${platform} 登录态，自动保存`);
              if (typeof recordLoginEvent === 'function') recordLoginEvent('window-closed-auto-save', { platform, count: cookies.count });
              await this.saveCookies(cookies, platform).catch((e) => console.warn('[Cookie] 自动保存失败:', e.message));
              resolve(cookies);
              return;
            }
          }
        } catch (e) { /* 未登录成功则忽略 */ }
        reject(new Error('用户关闭了登录窗口'));
      });
    });
  }

  injectConfirmButton(platform) {
    const buttonCode = `
      (function() {
        if (document.getElementById('electron-confirm-login')) return;

        const button = document.createElement('div');
        button.id = 'electron-confirm-login';
        button.innerHTML = '✓ 确认登录并返回';
        button.style.cssText = \`
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 999999;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 12px 24px;
          border-radius: 25px;
          font-size: 14px;
          font-weight: bold;
          cursor: pointer;
          user-select: none;
          box-shadow: 0 4px 15px rgba(0,0,0,0.3);
          transition: transform 0.3s ease, background 0.3s ease;
        \`;

        let dragging = false;
        let moved = false;
        let startX = 0, startY = 0;
        let offsetX = 0, offsetY = 0;
        button.addEventListener('mousedown', (e) => {
          dragging = true;
          moved = false;
          startX = e.clientX;
          startY = e.clientY;
          const rect = button.getBoundingClientRect();
          offsetX = e.clientX - rect.left;
          offsetY = e.clientY - rect.top;
          button.style.transition = 'none';
          e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
          if (!dragging) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
          button.style.right = 'auto';
          button.style.bottom = 'auto';
          button.style.left = (e.clientX - offsetX) + 'px';
          button.style.top = (e.clientY - offsetY) + 'px';
        });
        document.addEventListener('mouseup', () => {
          if (dragging) {
            dragging = false;
            button.style.transition = 'transform 0.3s ease, background 0.3s ease';
          }
        });

        button.onmouseover = () => {
          if (!dragging) button.style.transform = 'scale(1.05)';
        };
        button.onmouseout = () => {
          button.style.transform = 'scale(1)';
        };

        button.onclick = () => {
          if (moved) { moved = false; return; }
          if (window.loginAPI && window.loginAPI.confirmLogin) {
            window.loginAPI.confirmLogin('${platform}');
            button.innerHTML = '✓ 已确认，请稍候...';
            button.style.background = '#10b981';
          } else {
            alert('登录API未加载，请刷新页面重试');
          }
        };

        document.body.appendChild(button);
      })();
    `;

    this.loginWindow.webContents.executeJavaScript(buttonCode);
  }

  injectAddressBar() {
    const barCode = `
      (function() {
        if (!document.body) return;
        if (window.__electronAddrInterval) {
          clearInterval(window.__electronAddrInterval);
          window.__electronAddrInterval = null;
        }
        const oldBar = document.getElementById('electron-addr-bar');
        if (oldBar) oldBar.remove();

        const bar = document.createElement('div');
        bar.id = 'electron-addr-bar';
        bar.innerHTML = \`
          <div id="electron-addr-expanded" style="display:flex;align-items:center;gap:8px;width:100%;">
            <input id="electron-addr-input" placeholder="输入网址后回车跳转" style="flex:1;min-width:220px;padding:6px 10px;border:1px solid #d0d0d0;border-radius:6px;font-size:13px;outline:none;background:#fff;color:#333;box-sizing:border-box;box-shadow:inset 0 1px 2px rgba(0,0,0,0.05);" value="\${location.href.replace(/"/g, '&quot;')}"/>
            <button id="electron-addr-go" style="padding:6px 12px;border:none;border-radius:6px;background:#667eea;color:#fff;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;box-shadow:0 2px 5px rgba(102,126,234,0.3);">前往</button>
            <button id="electron-addr-refresh" style="padding:6px 12px;border:none;border-radius:6px;background:#10b981;color:#fff;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;box-shadow:0 2px 5px rgba(16,185,129,0.3);">刷新</button>
            <button id="electron-addr-toggle" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;background:#f3f4f6;color:#4b5563;font-size:12px;cursor:pointer;white-space:nowrap;font-weight:600;">▲ 收起</button>
          </div>
          <div id="electron-addr-collapsed" style="display:none;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#4b5563;font-weight:600;user-select:none;">
            <span>🌐 展开网址栏 ▾</span>
          </div>
        \`;

        bar.style.cssText = 'position:fixed;top:8px;right:20px;z-index:999998;display:flex;align-items:center;padding:6px 12px;background:rgba(255,255,255,0.96);backdrop-filter:blur(8px);border:1px solid rgba(0,0,0,0.15);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.15);font-family:system-ui,-apple-system,sans-serif;box-sizing:border-box;max-width:calc(100vw - 40px);transition:all 0.25s ease;';

        document.body.appendChild(bar);

        const expEl = document.getElementById('electron-addr-expanded');
        const colEl = document.getElementById('electron-addr-collapsed');
        const toggleBtn = document.getElementById('electron-addr-toggle');

        let isCollapsed = false;
        const setCollapsed = function(collapsed) {
          isCollapsed = collapsed;
          if (isCollapsed) {
            expEl.style.display = 'none';
            colEl.style.display = 'flex';
            bar.style.padding = '4px 12px';
            bar.style.background = 'rgba(255,255,255,0.92)';
            bar.style.borderRadius = '20px';
          } else {
            expEl.style.display = 'flex';
            colEl.style.display = 'none';
            bar.style.padding = '6px 12px';
            bar.style.background = 'rgba(255,255,255,0.96)';
            bar.style.borderRadius = '10px';
          }
        };

        toggleBtn.onclick = function(e) {
          e.stopPropagation();
          setCollapsed(true);
        };
        colEl.onclick = function(e) {
          e.stopPropagation();
          setCollapsed(false);
        };

        document.getElementById('electron-addr-go').onclick = function() {
          const u = document.getElementById('electron-addr-input').value.trim();
          if (u) location.href = u;
        };
        document.getElementById('electron-addr-refresh').onclick = function() {
          location.reload(true);
        };
        document.getElementById('electron-addr-input').addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { const u = this.value.trim(); if (u) location.href = u; }
        });

        const sync = function() {
          const inp = document.getElementById('electron-addr-input');
          if (inp && document.activeElement !== inp) inp.value = location.href;
        };
        window.__electronAddrInterval = setInterval(sync, 800);
        window.addEventListener('popstate', sync);
      })();
    `;
    this.loginWindow.webContents.executeJavaScript(barCode).catch(() => {});
  }

  autoOpenXhsLoginPanel() {
    if (!this.loginWindow || this.loginWindow.isDestroyed()) return;
    const js = `
      (function() {
        if (window.__xhsAutoLoginDone) return 'done';
        const findAndClick = function() {
          if (!document.body) return 'not-ready';
          const text = document.body.innerText || '';
          const html = document.body.innerHTML || '';
          // 登录面板已打开（已有扫码/二维码/登录弹窗等元素）则标记完成，切勿重复点击
          if (text.indexOf('扫码') !== -1 ||
              text.indexOf('手机号登录') !== -1 ||
              text.indexOf('登录后推荐') !== -1 ||
              html.indexOf('qr-code') !== -1 ||
              html.indexOf('qrcode') !== -1 ||
              html.indexOf('login-container') !== -1 ||
              document.querySelector('.login-container, .login-box, [class*="login-container"]')) {
            window.__xhsAutoLoginDone = true;
            return 'panel-open';
          }
          // 找导航栏/页头上的「登录」按钮，排除弹窗内部的 submit 提交按钮
          const btns = document.querySelectorAll('.login-btn, header button, .nav button, [class*="login-btn"]');
          for (const b of btns) {
            if (b.classList.contains('submit') || b.getAttribute('type') === 'submit') continue;
            if (b.closest && (b.closest('.login-container') || b.closest('.login-box'))) continue;
            const t = (b.textContent || '').trim();
            if (t === '登录' || t === '立即登录') {
              b.click();
              window.__xhsAutoLoginDone = true;
              return 'clicked';
            }
          }
          return 'not-found';
        };
        const result = findAndClick();
        if (result === 'panel-open' || result === 'clicked') return result;
        let tries = 0;
        window.__xhsAutoLoginTimer = setInterval(function() {
          tries++;
          const r2 = findAndClick();
          if (r2 !== 'not-found' || tries >= 20) {
            clearInterval(window.__xhsAutoLoginTimer);
            window.__xhsAutoLoginTimer = null;
          }
        }, 1500);
        return 'waiting';
      })();
    `;
    this.loginWindow.webContents.executeJavaScript(js).catch(() => {});
  }

  autoOpenDouyinLoginPanel() {
    if (!this.loginWindow || this.loginWindow.isDestroyed()) return;
    const js = `
      (function() {
        if (window.__dyAutoLoginDone) return 'done';
        const findAndClick = function() {
          if (!document.body) return 'not-ready';
          const text = document.body.innerText || '';
          const html = document.body.innerHTML || '';
          // 若页面已经有头像/个人中心/已登录Cookie，切勿再自动点击登录按钮
          if (document.querySelector('[data-e2e="avatar"], [data-e2e="user-avatar"], [class*="avatar"], a[href*="/user/"], [class*="user-info"]') ||
              /(^|;\s*)(sessionid_ss|sessionid|passport_auth_status)=/.test(document.cookie || '')) {
            window.__dyAutoLoginDone = true;
            return 'already-logged-in';
          }
          // 登录面板已打开（已有扫码/验证码/登录弹窗等）
          if (text.indexOf('扫码登录') !== -1 ||
              text.indexOf('手机号登录') !== -1 ||
              text.indexOf('密码登录') !== -1 ||
              html.indexOf('login-panel') !== -1 ||
              html.indexOf('login-guide-container') !== -1 ||
              html.indexOf('qrcode') !== -1 ||
              html.indexOf('qr-code') !== -1 ||
              document.querySelector('[data-e2e="login-panel"], .login-guide-container, [class*="login-panel"], [class*="login-container"], [class*="login-mask"], [class*="login-modal"]')) {
            window.__dyAutoLoginDone = true;
            return 'panel-open';
          }
          // 寻找导航栏/页头或页面上的「登录」按钮
          const loginBtn = document.querySelector('[data-e2e="nav-login-button"], .login-btn, [class*="login-btn"], [class*="login-button"], [class*="nav-login"]');
          if (loginBtn) {
            loginBtn.click();
            window.__dyAutoLoginDone = true;
            return 'clicked';
          }
          const allBtns = document.querySelectorAll('button, div, a, span');
          for (const b of allBtns) {
            if (b.children && b.children.length > 2) continue;
            const t = (b.textContent || '').trim();
            if (t === '登录' || t === '立即登录' || t === '登录 / 注册') {
              b.click();
              window.__dyAutoLoginDone = true;
              return 'clicked';
            }
          }
          return 'not-found';
        };
        const result = findAndClick();
        if (result === 'panel-open' || result === 'clicked') return result;
        let tries = 0;
        window.__dyAutoLoginTimer = setInterval(function() {
          tries++;
          const r2 = findAndClick();
          if (r2 !== 'not-found' || tries >= 20) {
            clearInterval(window.__dyAutoLoginTimer);
            window.__dyAutoLoginTimer = null;
          }
        }, 1200);
        return 'waiting';
      })();
    `;
    this.loginWindow.webContents.executeJavaScript(js).catch(() => {});
  }

  async extractCookies(ses, platform) {
    const cfg = getPlatformCookieConfig(platform);
    const domainKey = (cfg.importDomain || cfg.domain).replace(/^\./, '');
    const allCookies = await ses.cookies.get({});
    const cookies = allCookies.filter(c => {
      const d = String(c.domain || '').toLowerCase().replace(/^\./, '');
      return d.endsWith(domainKey) || domainKey.endsWith(d);
    });

    const cookieString = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const cookieDict = {};
    cookies.forEach(c => {
      cookieDict[c.name] = c.value;
    });

    return {
      cookieString,
      cookieDict,
      cookieArray: cookies,
      count: cookies.length
    };
  }

  /**
   * 用户点「确认登录」后，轮询等待完整登录态再提取 cookie。
   * 背景：快手等平台扫码后先种临时令牌（如 kuaishou.server.webday7_st），
   *       页面 JS 再换发完整登录 cookie（userId/web_st）。过早提取
   *       会抓到中间态，导致后续接口判定未登录。
   *
   * 判定逻辑（按平台）：
   *   - 抖音：存在 sessionid_ss / sessionid / sid_guard / sid_tt / passport_auth_status
   *   - 快手：存在 kuaishou.server.webday7_st 或 web_st，且 userId 存在
   *   - YouTube：存在 __Secure-1PSID, SID, HSID
   *   - 其他：存在对应平台的哨兵 cookie（sessionCookie），且非空
   * 最多等待 timeoutMs（默认 5s），超时后仍按当前 cookie 返回（不阻塞用户）。
   */
  async waitForLoginComplete(ses, platform, timeoutMs = 5000) {
    const cfg = getPlatformCookieConfig(platform);
    const isLoginComplete = (cookies) => {
      const hasValue = (n) => {
        const c = cookies.find(x => x.name === n);
        return c && String(c.value || '').length > 0;
      };
      if (platform === 'douyin') {
        return hasValue('sessionid_ss') || hasValue('sessionid') || hasValue('sid_guard') || hasValue('sid_tt') || hasValue('passport_auth_status');
      }
      if (platform === 'kuaishou') {
        const sentinel = hasValue('kuaishou.server.webday7_st') || hasValue('kuaishou.server.web_st');
        return sentinel && hasValue('userId');
      }
      if (platform === 'youtube') {
        return hasValue('__Secure-1PSID') && hasValue('SID') && hasValue('HSID');
      }
      return hasValue(cfg.sessionCookie);
    };

    // 点确认后等待短小延迟，让页面完成 Cookie 写入
    await new Promise(r => setTimeout(r, 800));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const extracted = await this.extractCookies(ses, platform);
      if (isLoginComplete(extracted.cookieArray)) {
        return extracted;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.warn(`[Cookie] ${platform} 登录态等待完成，按当前全域 cookie 返回`);
    return await this.extractCookies(ses, platform);
  }

  async saveCookies(cookies, platform) {
    try {
      platform = requireCookiePlatform(platform);
      // 保存到持久化存储（cookieKey 按 platform 区分）
      const cookieKey = `cookie_${platform}`;
      db.setKV(cookieKey, cookies.cookieString);
      db.flushNow();
      store.delete(cookieKey);

      console.log(`[Cookie] 已安全保存 ${platform} 登录凭据，共 ${cookies.count || 0} 条`);
      if (typeof recordLoginEvent === 'function') recordLoginEvent('cookies-saved', { platform, count: cookies.count || 0, length: cookies.cookieString?.length || 0 });

      // 同步到分区会话，内置浏览器（webview 同 partition）立即生效
      await syncCookiesToSession(platform).catch(() => {});

      refreshPlatformCredentialConsumers(platform);
      notifyLoginStatusChanged(platform);
      return { success: true, message: 'Cookie saved successfully' };
    } catch (error) {
      const secretFailure = secretFailureResult(error);
      if (secretFailure) {
        const safeError = Object.assign(new Error(secretFailure.error), secretFailure);
        safeError.cause = error;
        throw safeError;
      }
      const persistenceFailure = persistenceFailureResult(error);
      if (persistenceFailure) {
        const safeError = Object.assign(new Error(persistenceFailure.error), persistenceFailure);
        safeError.cause = error;
        throw safeError;
      }
      console.error('保存Cookie失败:', error);
      throw error;
    }
  }
}

const cookieManager = new CookieManager();

// 把 DB 里保存的 Cookie 字符串同步写入对应平台的 Electron 分区会话，
// 让「内置浏览器」(webview 使用同一 partition) 直接共享登录态。
// 覆盖三种来源：登录窗口（openLoginWindow）、从本机浏览器导入、手动粘贴。
async function syncCookiesToSession(platform) {
  platform = requireCookiePlatform(platform);
  const cfg = getPlatformCookieConfig(platform);
  const cookieKey = `cookie_${platform}`;
  const cookieString = String(db.getKV(cookieKey, '') || '').trim();
  if (!cookieString) return 0;
  try {
    const ses = session.fromPartition(`persist:${platform}`);
    let count = 0;
    const cleanDomain = cfg.domain.startsWith('.') ? cfg.domain : `.${cfg.domain}`;
    const baseHost = cfg.domain.replace(/^\./, '');
    for (const pair of cookieString.split(';')) {
      const p = pair.trim();
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      if (!name) continue;
      try {
        await ses.cookies.set({
          url: `https://${baseHost}/`,
          domain: cleanDomain,
          name,
          value,
          path: '/',
          secure: true,
          sameSite: 'no_restriction',
        });
        count++;
      } catch (e) {
        try {
          await ses.cookies.set({
            url: `https://www.${baseHost}/`,
            name,
            value,
            path: '/',
          });
          count++;
        } catch (_) {}
      }
    }
    if (count > 0) console.log(`[CookieSync] 已同步 ${count} 个 ${platform} Cookie 到内置浏览器会话 (${cleanDomain})`);
    return count;
  } catch (error) {
    console.error(`[CookieSync] ${platform} 同步失败:`, error.message);
    return 0;
  }
}

function refreshPlatformCredentialConsumers(platform) {
  if (platform === 'douyin') {
    douyinAPI = buildDouyinAPI();
  } else if (platform === 'tiktok') {
    tiktokAPI = buildTiktokAPI();
  } else if (platform === 'xiaohongshu') {
    try { xhsProfile.destroy(); } catch (_) { /* ignore */ }
  } else if (platform === 'kuaishou') {
    try { kuaishouProfile.destroy(); } catch (_) { /* ignore */ }
  }
}

async function clearPlatformCredentials(platform) {
  const normalized = requireCookiePlatform(platform);
  const failures = [];
  const ses = session.fromPartition(`persist:${normalized}`);

  try { await ses.clearCache(); } catch (error) { failures.push(error); }
  try {
    await ses.clearStorageData({
      storages: [
        'appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage',
        'shadercache', 'websql', 'serviceworkers', 'cachestorage',
      ],
    });
  } catch (error) {
    failures.push(error);
  }

  try {
    db.deleteKV(`cookie_${normalized}`);
    if (normalized === 'douyin') db.clearMyAccountSecrets();
    db.flushNow();
  } catch (error) {
    failures.push(error);
  }

  try { store.delete(`cookie_${normalized}`); } catch (error) { failures.push(error); }
  try { cleanupCookieFiles({ platform: normalized }); } catch (error) { failures.push(error); }

  if (cookieManager.loginWindow
    && cookieManager.loginPlatform === normalized
    && !cookieManager.loginWindow.isDestroyed()) {
    try { cookieManager.loginWindow.close(); } catch (error) { failures.push(error); }
  }
  if (normalized === 'yuanbao' && yuanbaoLoginWindow && !yuanbaoLoginWindow.isDestroyed()) {
    try { yuanbaoLoginWindow.close(); } catch (error) { failures.push(error); }
  }
  refreshPlatformCredentialConsumers(normalized);
  notifyLoginStatusChanged(normalized);

  if (failures.length) {
    const error = new Error('部分登录数据未能清除，请关闭登录窗口后重试');
    error.code = 'CREDENTIAL_CLEAR_FAILED';
    throw error;
  }
  return { success: true };
}

// ===== IPC处理程序 =====

const WINDOW_CONTROL_ACTIONS = new Set(['minimize', 'toggle-maximize', 'close']);

function getSenderWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window && !window.isDestroyed() ? window : null;
}

ipcMain.handle('window-control', async (event, action) => {
  if (!WINDOW_CONTROL_ACTIONS.has(action)) {
    return { success: false, error: '不支持的窗口操作' };
  }
  const window = getSenderWindow(event);
  if (!window) return { success: false, error: '窗口不存在' };

  if (action === 'minimize') {
    window.minimize();
    return { success: true, isMaximized: window.isMaximized() };
  }
  if (action === 'toggle-maximize') {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return { success: true, isMaximized: window.isMaximized() };
  }

  window.close();
  return { success: true, isMaximized: false };
});

ipcMain.handle('get-window-state', async (event) => {
  const window = getSenderWindow(event);
  if (!window) return { success: false, error: '窗口不存在', isMaximized: false };
  return { success: true, isMaximized: window.isMaximized() };
});

// Cookie管理
ipcMain.handle('open-login-window', async (event, platform) => {
  try {
    platform = requireCookiePlatform(platform);
    const cookies = await cookieManager.openLoginWindow(platform);
    await cookieManager.saveCookies(cookies, platform);
    return { success: true, count: cookies.count || 0 };
  } catch (error) {
    const secretFailure = secretFailureResult(error);
    if (secretFailure) return secretFailure;
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-cookies', async (event, platform) => {
  try {
    const normalized = requireCookiePlatform(platform);
    const ses = session.fromPartition(`persist:${normalized}`);
    const cfg = getPlatformCookieConfig(normalized);
    const sessionEntries = await ses.cookies.get({ domain: cfg.domain });
    return {
      success: true,
      configured: !!db.getKV(`cookie_${normalized}`, ''),
      count: sessionEntries.length,
      entries: sessionEntries.map(entry => ({
        name: entry.name,
        domain: entry.domain,
        expirationDate: entry.expirationDate || null,
        secure: !!entry.secure,
        httpOnly: !!entry.httpOnly,
      })),
    };
  } catch (error) {
    const secretFailure = secretFailureResult(error);
    if (secretFailure) return secretFailure;
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-cookies', async (event, platform) => {
  try {
    return await clearPlatformCredentials(platform);
  } catch (error) {
    return { success: false, code: error.code || 'CREDENTIAL_CLEAR_FAILED', error: error.message };
  }
});

// 列出本机可用的浏览器
ipcMain.handle('list-browsers', async () => {
  try {
    return { success: true, browsers: listAvailableBrowsers() };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 从本机浏览器导入 Cookie（按 platform 区分域名与存储 key）
ipcMain.handle('import-browser-cookies', async (event, browserKey, platform) => {
  try {
    const plat = requireCookiePlatform(platform || 'douyin');
    const cfg = getPlatformCookieConfig(plat);
    const cookieKey = `cookie_${plat}`;
    const { cookieString, count } = await getCookiesFromBrowser(browserKey, cfg.importDomain);
    db.setKV(cookieKey, cookieString);
    db.flushNow();
    store.delete(cookieKey);
    refreshPlatformCredentialConsumers(plat);
    // 同步到分区会话，内置浏览器（webview 同 partition）立即生效
    await syncCookiesToSession(plat).catch(() => {});
    notifyLoginStatusChanged(plat);
    console.log(`[BrowserCookie] 已从 ${browserKey} 导入 ${count} 个 ${plat} Cookie`);
    return { success: true, count };
  } catch (error) {
    const secretFailure = secretFailureResult(error);
    if (secretFailure) return secretFailure;
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    console.error('[BrowserCookie] 导入失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 关闭本机浏览器进程（导入 Cookie 前解锁文件用）
// 优雅关闭：先尝试 WM_CLOSE（taskkill 无 /F），失败再强制结束
ipcMain.handle('close-browser', async (event, browserKey) => {
  const procName = { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' }[browserKey];
  if (!procName) return { success: false, error: '未知浏览器' };
  try {
    // 先优雅关闭（给浏览器发关闭信号，等同点右上角×）
    try {
      execFileSync('taskkill', ['/IM', procName], { windowsHide: true, stdio: 'ignore' });
    } catch (_) { /* 没有进程也无所谓 */ }

    // 轮询等待进程退出 + 文件锁释放（最多 ~8 秒）
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let exited = false;
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      let stillRunning = false;
      try {
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${procName}`, '/NH', '/FO', 'CSV'],
          { encoding: 'utf8', windowsHide: true });
        stillRunning = out.includes(procName);
      } catch (_) { /* ignore */ }
      if (!stillRunning) { exited = true; break; }
    }
    // 仍未退出则强制结束
    if (!exited) {
      try { execFileSync('taskkill', ['/F', '/IM', procName], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
      await sleep(800);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 手动粘贴 Cookie 字符串（按 platform 区分存储 key）
ipcMain.handle('set-cookie-manual', async (event, cookieString, platform) => {
  try {
    const plat = requireCookiePlatform(platform || 'douyin');
    const cookieKey = `cookie_${plat}`;
    const cs = String(cookieString || '').trim().replace(/^Cookie:\s*/i, '');
    if (!cs || !cs.includes('=')) {
      return { success: false, error: 'Cookie 格式不正确，应形如 name=value; name2=value2' };
    }
    db.setKV(cookieKey, cs);
    db.flushNow();
    store.delete(cookieKey);
    refreshPlatformCredentialConsumers(plat);
    const status = getStoredCredentialStatus(plat, cs);
    // 同步到分区会话，内置浏览器（webview 同 partition）立即生效
    await syncCookiesToSession(plat).catch(() => {});
    notifyLoginStatusChanged(plat);
    console.log(`[ManualCookie] 已保存手动粘贴的 ${plat} Cookie, 登录态:`, status.isLoggedIn);
    return { success: true, isLoggedIn: status.isLoggedIn, message: status.message };
  } catch (error) {
    const secretFailure = secretFailureResult(error);
    if (secretFailure) return secretFailure;
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    return { success: false, error: error.message };
  }
});

// TikTok 登录态校验：哨兵 cookie 名为 sessionid（不同于抖音的 sessionid_ss）
function checkTiktokCookieStatus(apiInstance) {
  const cookies = (apiInstance.cookie || '').split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith('sessionid='));
  if (sessionCookie && sessionCookie.split('=')[1]) {
    return { isValid: true, isLoggedIn: true, message: 'Cookie有效，已登录' };
  } else if (apiInstance.cookie) {
    return { isValid: true, isLoggedIn: false, message: 'Cookie存在但未登录' };
  } else {
    return { isValid: false, isLoggedIn: false, message: 'Cookie为空' };
  }
}

// 小红书登录态校验：哨兵 cookie 名为 web_session（登录后必有）
// 小红书没有 API 类实例，直接从 DB 读 cookie 字符串判断
function checkXhsCookieStatus() {
  const cs = db.getKV('cookie_xiaohongshu', '') || '';
  if (!cs) {
    return { isValid: false, isLoggedIn: false, message: 'Cookie为空，请先登录小红书' };
  }
  const cookies = cs.split(';').map(c => c.trim()).filter(Boolean);
  const session = cookies.find(c => c.startsWith('web_session='));
  if (session && session.split('=')[1]) {
    // 注意：这里只校验 web_session cookie 存在，不代表服务器端会话一定有效。
    // 小红书 web_session 在服务器端可能已过期（cookie 本身有效期到 2027 年，但服务端
    // 会主动失效）。真正的有效性只有在调用接口时才能知道--如果下载/解析时报
    // "登录态失效"，就是服务端会话过期了，需要重新登录。
    return { isValid: true, isLoggedIn: true, message: '已登录小红书（cookie 存在；若下载报登录失效，请重新登录）' };
  }
  return { isValid: true, isLoggedIn: false, message: 'Cookie存在但未登录（缺少 web_session），请重新登录小红书' };
}

// 快手登录态校验：哨兵 cookie 名为 kuaishou.server.webday7_st（web_st 已废弃，现用 webday7_st）
// 快手暂未接入 API 实例，直接从 DB 读 cookie 字符串判断
function checkKuaishouCookieStatus() {
  const cs = db.getKV('cookie_kuaishou', '') || '';
  if (!cs) {
    return { isValid: false, isLoggedIn: false, message: 'Cookie为空，请先登录快手' };
  }
  const cookies = cs.split(';').map(c => c.trim()).filter(Boolean);
  const session = cookies.find(c => c.startsWith('kuaishou.server.webday7_st='));
  if (session && session.split('=')[1]) {
    return { isValid: true, isLoggedIn: true, message: 'Cookie有效，已登录快手' };
  }
  return { isValid: true, isLoggedIn: false, message: 'Cookie存在但未登录（缺少 kuaishou.server.webday7_st）' };
}

// ===== 视频号下载（腾讯元宝扫码登录 + 两步解析 + ISAAC 流式解密）=====


// Native API handlers
ipcMain.handle('native-api', async (event, { platform, method, params }) => {
  try {
    console.log('[Native API] Request:', { platform, method, params });

    // TikTok 主页解析：官方 item_list 接口受 WAF 拦截，改走 tikwm（隐藏窗口过 Cloudflare）
    // 只接管主页相关的两个方法，其余 TikTok 方法仍走原 tiktokAPI（单视频等）
    if (platform === 'tiktok' && (method === 'getUserProfile' || method === 'getUserVideos')) {
      let result;
      if (method === 'getUserProfile') {
        result = await tiktokProfile.getUserProfile(params.uniqueId || params.secUserId);
      } else {
        result = await tiktokProfile.getUserVideos(
          params.uniqueId || params.secUserId,
          params.cursor,
          params.count
        );
      }
      console.log('[Native API] (tiktok/tikwm) Response ok, method:', method);
      return { success: true, data: result };
    }

    // 按 platform 选择 API 实例（tiktok 走 tiktokAPI，其余走 douyinAPI）
    const api = platform === 'tiktok' ? tiktokAPI : douyinAPI;

    let result;
    switch (method) {
      case 'resolveShareLink':
        result = await api.resolveShareLink(params.url);
        break;
      case 'getVideoDetail':
        result = await api.getVideoDetail(params.id);
        break;
      case 'getUserProfile':
        result = await api.getUserProfile(params.secUserId || params.uniqueId);
        break;
      case 'getUserVideos':
        result = await api.getUserVideos(params.secUserId, params.cursor, params.count);
        break;
      case 'getUserLikedVideos':
        result = await api.getUserLikedVideos(params.secUserId, params.cursor, params.count);
        break;
      case 'getUserCollections':
        result = await api.getUserCollections(params.secUserId, params.cursor, params.count);
        break;
      case 'getVideoComments':
        result = await api.getVideoComments(params.awemeId, params.cursor, params.count);
        break;
      case 'searchVideos':
        result = await api.searchVideos(params.keyword, params.offset, params.count);
        break;
      case 'searchUsers':
        result = await api.searchUsers(params.keyword, params.offset, params.count);
        break;
      case 'getLiveStream':
        result = await api.getLiveStream(params.webRid);
        break;
      case 'getMixVideos':
        result = await api.getMixVideos(params.mixId, params.cursor, params.count);
        break;
      case 'getHotBoard':
        result = await api.getHotBoard(params.boardType);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    console.log('[Native API] Response:', result);
    return { success: true, data: result };
  } catch (error) {
    console.error('[Native API] Error:', error.message);
    console.error('[Native API] Stack:', error.stack);
    return {
      success: false,
      error: error.message,
      details: error.stack
    };
  }
});

// Python API代理 (deprecated, kept for compatibility)
ipcMain.handle('python-api', async (event, endpoint, data) => {
  // Redirect to native API
  console.warn('[Deprecated] python-api called, please use native-api instead');
  return { success: false, error: 'Python backend is disabled. Use native API instead.' };
});

// 获取后端状态 (always true with native API)
ipcMain.handle('check-python-status', async () => {
  return { running: true, native: true };
});

// 顶部标题栏五个平台的统一登录状态（仅返回脱敏元数据）
ipcMain.handle('get-login-status-summary', async () => {
  return loginStatusService.getSummary();
});

// 检查单个平台 Cookie 状态（严格按平台哨兵判断，不再回退到抖音）
ipcMain.handle('check-cookie-status', async (event, platform) => {
  try {
    const normalized = requireCookiePlatform(platform || 'douyin');
    const cookieString = db.getKV(`cookie_${normalized}`, '') || '';
    const status = getStoredCredentialStatus(normalized, cookieString);
    return { success: true, ...status };
  } catch (error) {
    console.error('[Cookie Status] 检查失败:', error);
    return { success: false, error: error.message };
  }
});

// 抖音登录状态全链路诊断（供界面展示、诊断导出与开发排查）
ipcMain.handle('diagnose-douyin-login', async () => {
  try {
    const report = await runDouyinDiagnostic({ db, session, axiosImpl: axios });
    return { success: true, report };
  } catch (error) {
    console.error('[Douyin Diagnostic] 诊断执行失败:', error);
    return { success: false, error: error.message };
  }
});

// ===== 控制端API处理程序 =====

// 获取控制端配置
ipcMain.handle('get-control-panel-config', async () => {
  return {
    url: db.getKV('control_panel_url', CONTROL_PANEL_API_URL),
    version: APP_VERSION
  };
});

// 设置控制端URL
ipcMain.handle('set-control-panel-url', async (event, url) => {
  try {
    const normalized = validateHttpUrl(url);
    if (new URL(normalized).protocol !== 'https:') {
      return { success: false, error: '控制端地址必须使用 HTTPS' };
    }
    db.setKV('control_panel_url', normalized);
    db.flushNow();
    // 冗余备份 + 启动早期常量读取
    store.set('control_panel_url', normalized);
    return { success: true };
  } catch (error) {
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    return { success: false, error: error.message };
  }
});

// 获取控制端广告
ipcMain.handle('get-control-panel-ads', async () => {
  try {
    const response = await controlPanelRequest('get_ads');

    if (response.data && response.data.success) {
      return { success: true, data: response.data.data };
    } else {
      return { success: false, error: response.data?.message || '获取广告失败' };
    }
  } catch (error) {
    console.error('[Control Panel] 获取广告失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 获取推广信息页面的自定义 HTML 内容（可能含 promo_url，客户端优先加载网址）
ipcMain.handle('get-control-panel-promo', async () => {
  try {
    const response = await controlPanelRequest('get_promo_html');

    if (response.data && response.data.success) {
      let promoUrl = '';
      if (response.data.url) {
        try {
          const controlUrl = validateHttpUrl(db.getKV('control_panel_url', CONTROL_PANEL_API_URL));
          const controlHost = new URL(controlUrl).hostname;
          promoUrl = validateExternalUrl(response.data.url, [controlHost, `*.${controlHost}`]);
        } catch (_) {
          promoUrl = '';
        }
      }
      return { success: true, html: response.data.html || '', url: promoUrl };
    } else {
      return { success: false, error: response.data?.message || '获取推广内容失败' };
    }
  } catch (error) {
    console.error('[Control Panel] 获取推广内容失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 获取客户端配置（按钮名称等）
ipcMain.handle('get-client-config', async () => {
  try {
    const response = await controlPanelRequest('get_client_config');

    console.log('[Control Panel] API 原始响应:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.success) {
      const result = {
        success: true,
        button_name: response.data.button_name,
        show_ads_on_startup: response.data.show_ads_on_startup
      };
      console.log('[Control Panel] 返回给前端的数据:', JSON.stringify(result, null, 2));
      return result;
    } else {
      return { success: false, error: response.data?.message || '获取配置失败' };
    }
  } catch (error) {
    console.error('[Control Panel] 获取客户端配置失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 检查版本更新
ipcMain.handle('check-control-panel-version', async () => {
  try {
    const response = await controlPanelRequest(`check_version&version=${APP_VERSION}`);

    if (response.data && response.data.success) {
      return { success: true, ...response.data };
    } else {
      return { success: false, error: response.data?.message || '检查更新失败' };
    }
  } catch (error) {
    console.error('[Control Panel] 检查更新失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 获取弹窗配置
ipcMain.handle('get-control-panel-popup', async () => {
  try {
    const response = await controlPanelRequest('get_popup');

    if (response.data && response.data.success) {
      return { success: true, enabled: response.data.enabled, url: response.data.url };
    } else {
      return { success: false, error: response.data?.message || '获取弹窗配置失败' };
    }
  } catch (error) {
    console.error('[Control Panel] 获取弹窗配置失败:', error.message);
    return { success: false, error: error.message };
  }
});

// IP统计上报
ipcMain.handle('report-ip-to-control-panel', async () => {
  try {
    const os = require('os');
    const osInfo = `${os.platform()} ${os.release()} ${os.arch()}`;

    const response = await controlPanelRequest('report_ip', {
      method: 'POST',
      data: { version: APP_VERSION, os_info: osInfo }
    });

    if (response.data && response.data.success) {
      return { success: true, ip: response.data.ip };
    } else {
      return { success: false, error: response.data?.message || 'IP上报失败' };
    }
  } catch (error) {
    console.error('[Control Panel] IP上报失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 打开外部URL（在系统浏览器中）
ipcMain.handle('open-external-url', async (event, url) => {
  try {
    await openAllowedExternalUrl(url);
    return { success: true };
  } catch (error) {
    console.error('[Shell] 打开URL失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 复制文本到剪贴板（作品弹窗批量复制链接等场景）
ipcMain.handle('copy-text', async (event, text) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return { success: true };
  } catch (error) {
    console.error('[Clipboard] 复制失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 选择文件夹
ipcMain.handle('select-folder', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (result.canceled) {
    return null;
  }

  return downloadDirectoryTokens.grant(event.sender.id, result.filePaths[0]);
});

// ===== 设置管理 =====

// 默认设置
function getDefaultSettings() {
  return {
    root: app.getPath('downloads'),
    folder_name: '',
    // 文件命名模板：默认「标题 作品ID」（显示在设置里，用户可点击标签/手改按需修改）
    name_format: '标题 作品ID',
    folder_mode: false,
    concurrency: 5,
    proxy: '',
    timeout: 10,
    max_retry: 5,
  };
}

function normalizeSettings(input = {}) {
  const defaults = getDefaultSettings();
  const integerInRange = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  return {
    root: typeof input.root === 'string' && input.root.trim() ? input.root.trim() : defaults.root,
    folder_name: typeof input.folder_name === 'string' ? input.folder_name.trim() : defaults.folder_name,
    name_format: typeof input.name_format === 'string' && input.name_format.trim()
      ? input.name_format.trim()
      : defaults.name_format,
    folder_mode: input.folder_mode === true,
    concurrency: integerInRange(input.concurrency, defaults.concurrency, 1, 10),
    proxy: typeof input.proxy === 'string' ? input.proxy.trim() : defaults.proxy,
    timeout: integerInRange(input.timeout, defaults.timeout, 1, 300),
    max_retry: integerInRange(input.max_retry, defaults.max_retry, 0, 20),
  };
}

// 读取设置（与默认值合并，保证字段完整）
ipcMain.handle('get-settings', async () => {
  return getCurrentSettings();
});

function getCurrentSettings() {
  const saved = db.getKV('settings', {}) || {};
  return normalizeSettings(saved);
}

// 按「文件命名格式」模板渲染文件名（变量以空格分隔，中文或英文写法均可，如 "下载时间 类型 作者 标题"）。
// 可用变量：下载时间/下载日期(download_time) 作品时间(create_time) 类型(type) 作者(nickname)
//          标题(desc) 作品ID(id) 作者ID(uid) 备注(mark)
// 渲染结果缺少任何内容标识（只剩 类型 等）或为空时，回退到 fallback
function applyNameFormat(format, videoInfo, fallback) {
  const fmt = String(format || '').trim();
  if (!fmt || !videoInfo) return fallback;
  try {
    const vi = videoInfo || {};
    const isAlbum = (vi.type === 'image') || (vi.albumItems && vi.albumItems.length > 0);
    const pad = (n) => String(n).padStart(2, '0');
    const fmtDate = (d) => (isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    // 作品发布日期（vi.create_time 为秒级时间戳）
    let publishDate = '';
    if (vi.create_time) publishDate = fmtDate(new Date(Number(vi.create_time) * 1000));
    // 下载时间 = 任务创建当天日期
    const downloadDate = fmtDate(new Date());
    const vars = {
      'download_time': downloadDate,
      'create_time': publishDate,
      'type': isAlbum ? '图集' : '视频',
      'nickname': String(vi.author || '').trim(),
      'desc': String(vi.desc || vi.title || '').trim(),
      'id': String(vi.awemeId || '').trim(),
      'uid': String(vi.uid || (vi.author && vi.author.uid) || '').trim(),
      'mark': String(vi.mark || '').trim(),
    };
    // 中文变量名先归一化为英文 key（长词优先，避免「作者ID」被「作者」先截断），
    // 再按「字母(+下划线)」token 逐个查表替换：
    //   1) 支持 download_time / create_time 这类复合变量（整体匹配）；
    //   2) 也支持被下划线/空格包围的 desc / id 等单变量（下划线当分隔符，不阻塞匹配）；
    //   3) 非变量词（如用户输入的其他英文）原样保留。
    const zhMap = {
      '下载时间': 'download_time', '下载日期': 'download_time', '日期': 'download_time',
      '作品时间': 'create_time', '发布日期': 'create_time',
      '类型': 'type',
      '作者ID': 'uid', '作者id': 'uid', '作者昵称': 'nickname', '作者': 'nickname',
      '标题': 'desc', '文案': 'desc', '描述': 'desc',
      '作品ID': 'id', '作品id': 'id',
      '备注': 'mark',
    };
    const zhRe = /下载时间|下载日期|日期|作品时间|发布日期|类型|作者ID|作者id|作者昵称|作者|标题|文案|描述|作品ID|作品id|备注/g;
    let name = fmt
      .replace(zhRe, (w) => zhMap[w] || w)
      .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, (tok) => (vars[tok] !== undefined ? (vars[tok] || '') : tok));
    // 清理非法字符、折叠多余空格、去首尾分隔符
    name = name.replace(/[<>:"/\\|?*\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[_\s-]+|[_\s-]+$/g, '');
    // 仅剩 type 而无任何内容标识时视为无效（避免所有视频都叫 "视频"）
    const hasIdentity = /[\u4e00-\u9fa5a-zA-Z0-9]/.test(name.replace(/视频|图集/g, ''));
    if (!name || !hasIdentity) return fallback;
    // 补回文件扩展名（从 fallback 提取，如 .mp4/.jpg/.mov），避免渲染结果丢失后缀
    const extMatch = String(fallback || '').match(/\.([A-Za-z0-9]{1,6})$/);
    let ext = '';
    if (extMatch && !new RegExp('\\.' + extMatch[1] + '$', 'i').test(name)) ext = '.' + extMatch[1];
    return name.slice(0, 100 - ext.length) + ext;
  } catch (e) {
    return fallback;
  }
}

// 保存设置
ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const merged = normalizeSettings(settings || {});
    db.setKV('settings', merged);
    db.flushNow();
    // 同步回 electron-store（冗余备份 + 供启动早期 buildDouyinAPI 读取）
    store.set('settings', merged);
    // 重建 API 实例，使超时/重试等设置立即生效（两个平台都重建）
    douyinAPI = buildDouyinAPI();
    tiktokAPI = buildTiktokAPI();
    downloadScheduler.setLimit(merged.concurrency);
    console.log('[Settings] 已保存设置, 下载目录:', merged.root);
    return { success: true };
  } catch (error) {
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    console.error('[Settings] 保存失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 保存主题（持久化到磁盘，跨会话保留）
ipcMain.handle('save-theme', async (event, theme) => {
  try {
    db.setKV('theme', theme);
    db.flushNow();
    return { success: true };
  } catch (error) {
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    console.error('[Theme] 保存失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 读取主题（启动时由渲染进程通过 localStorage 优先读取，这里仅作兜底）
ipcMain.handle('get-theme', async () => {
  return db.getKV('theme', 'light') || 'light';
});

// 净化文件夹名称（移除非法字符、结尾的点和空格，限制长度）
function sanitizeFolderName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\n\r\t]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 100);
}

// 计算实际下载目录：优先使用用户配置的目录，必要时创建；失败则回退系统下载目录
// videoInfo 用于"按账号创建文件夹"模式（folder_mode）
function getDownloadDir(videoInfo = null) {
  const settings = db.getKV('settings', {}) || {};
  const fallback = app.getPath('downloads');

  let dir = settings.root && String(settings.root).trim()
    ? String(settings.root).trim()
    : fallback;

  // 可选的子文件夹
  if (settings.folder_name && String(settings.folder_name).trim()) {
    const sub = sanitizeFolderName(settings.folder_name);
    if (sub) dir = path.join(dir, sub);
  }

  // 按账号创建文件夹：在目录下再建一层以作者昵称命名的文件夹
  if (settings.folder_mode && videoInfo && videoInfo.author) {
    const authorFolder = sanitizeFolderName(videoInfo.author);
    if (authorFolder) dir = path.join(dir, authorFolder);
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (error) {
    console.error('[Download] 无法创建下载目录，回退到系统下载目录:', error.message);
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch (_) { /* ignore */ }
    return fallback;
  }
}

// 下载任务列表和并发调度
let downloadTasks = [];
const taskExecutionPromises = new Map();
const taskFinalizers = new WeakMap();
const taskCancellationStatuses = new WeakMap();
const MAX_CONCURRENT_DOWNLOADS = 5;
const downloadScheduler = createScheduler({
  limit: MAX_CONCURRENT_DOWNLOADS,
  run: runScheduledDownload,
  onError: (task, error) => {
    console.error('[Download Scheduler] 下载失败:', task && task.id, error && (error.code || error.message));
  },
});

async function runScheduledDownload(task) {
  const execution = Promise.resolve().then(() => executeDownload(task));
  taskExecutionPromises.set(task.id, execution);
  try {
    return await execution;
  } finally {
    if (taskExecutionPromises.get(task.id) === execution) {
      taskExecutionPromises.delete(task.id);
    }
  }
}

function emitDownloadTerminalEvent(channel, task) {
  if (!channel || !mainWindow || mainWindow.isDestroyed()) return;
  const webContents = mainWindow.webContents;
  if (!webContents || webContents.isDestroyed()) return;

  const terminalState = {
    id: task.id,
    revision: Number.isSafeInteger(task.revision) ? task.revision : 0,
    endTime: task.endTime || Date.now(),
  };
  let payload;
  if (channel === 'download-completed') {
    payload = { ...terminalState, path: task.savePath, skipped: !!task.skipped };
  } else if (channel === 'download-failed') {
    payload = { ...terminalState, error: task.error || '下载失败' };
  } else if (channel === 'download-stopped') {
    payload = { ...terminalState, path: task.savePath };
  } else if (channel === 'download-deleted') {
    payload = terminalState;
  } else {
    payload = { ...terminalState, path: task.savePath, error: task.error || null };
  }
  try { webContents.send(channel, payload); } catch (_) { /* window closed during finalization */ }
}

function getTaskFinalizer(task) {
  let finalize = taskFinalizers.get(task);
  if (finalize) return finalize;

  finalize = createTaskFinalizer({
    task,
    cleanup: async () => {
      delete task.cancelSource;
      delete task.writer;
      delete task.ytdlProcess;
      delete task.runtime;
    },
    persist: async () => saveDownloadTasks(),
    emit: async (channel, payload) => emitDownloadTerminalEvent(channel, payload),
  });
  taskFinalizers.set(task, finalize);
  return finalize;
}

async function finalizeDownloadTask(task, status, patch = {}) {
  const finalize = getTaskFinalizer(task);
  const result = await finalize(status, patch);
  if (result) {
    if (taskFinalizers.get(task) === finalize) taskFinalizers.delete(task);
    taskCancellationStatuses.delete(task);
  }
  return result;
}

function requestTaskCancellation(task, terminalStatus = 'stopped') {
  if (!task || typeof task !== 'object') return false;
  task.cancelled = true;
  taskCancellationStatuses.set(task, terminalStatus);

  const runtime = task.runtime;
  if (runtime) {
    runtime.requestedTerminal = terminalStatus;
    const controllerCanAbort = runtime.controller && !runtime.controller.signal.aborted;
    if (controllerCanAbort) runtime.controller.abort();
    if (runtime.childProcess && !controllerCanAbort) {
      void terminateProcessTree(runtime.childProcess);
    }
  }
  if (task.cancelSource && typeof task.cancelSource.cancel === 'function') {
    try { task.cancelSource.cancel(terminalStatus === 'deleted' ? '用户删除任务' : '用户停止下载'); } catch (_) {}
  }
  if (task.writer && typeof task.writer.destroy === 'function') {
    try { task.writer.destroy(); } catch (_) {}
  }
  return true;
}

async function waitForTaskExecution(taskId) {
  const execution = taskExecutionPromises.get(taskId);
  if (!execution) return false;
  try {
    await execution;
  } catch (_) {
    // The scheduler records the sanitized execution error; cleanup still continues.
  }
  return true;
}

function cleanupTaskTemporaryOutput(task) {
  if (!task || typeof task !== 'object') return;
  if (typeof task.savePath === 'string' && task.savePath) {
    const partPath = createPartPath(task.savePath, task.id);
    try { fs.rmSync(partPath, { force: true }); } catch (_) {}
  }

  if (typeof task.tmpDir === 'string' && path.isAbsolute(task.tmpDir)) {
    const resolvedTempDir = path.resolve(task.tmpDir);
    const tempName = path.basename(resolvedTempDir);
    const isKnownTaskTemp = /_(?:dash_tmp|hls_tmp|dash_mpd_tmp)_[a-z0-9]+$/i.test(tempName);
    if (isKnownTaskTemp && path.dirname(resolvedTempDir) !== resolvedTempDir) {
      try { fs.rmSync(resolvedTempDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

async function deleteDownloadTaskById(taskId) {
  const taskIndex = downloadTasks.findIndex(task => task.id === taskId);
  if (taskIndex === -1) return false;
  const task = downloadTasks[taskIndex];
  const removedFromScheduler = downloadScheduler.remove(taskId);

  if (removedFromScheduler) {
    await finalizeDownloadTask(task, 'deleted', { error: null });
  } else if (task.status === 'pending' || task.status === 'downloading') {
    requestTaskCancellation(task, 'deleted');
  }

  await waitForTaskExecution(task.id);
  if (task.status === 'pending' || task.status === 'downloading') {
    await finalizeDownloadTask(task, 'deleted', { error: null });
  }
  cleanupTaskTemporaryOutput(task);
  releaseDownloadPath(task.savePath);

  const currentIndex = downloadTasks.findIndex(item => item.id === taskId);
  if (currentIndex !== -1) downloadTasks.splice(currentIndex, 1);
  db.deleteDownloadTask(taskId);
  return true;
}

function enqueueDownload(task) {
  const enqueued = downloadScheduler.enqueue(task);
  if (!enqueued) {
    console.warn('[Download Scheduler] 任务未入队（ID 无效或已存在）:', task && task.id);
  }
  return enqueued;
}

// 加载持久化的下载任务
function loadDownloadTasks() {
  const savedTasks = db.listDownloadTasks() || [];
  // 按 startTime 降序：最新下载排在最前面（DB 虽已 ORDER BY，这里再保险一次，保证内存态有序）
  savedTasks.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  downloadTasks = savedTasks.map(task => {
    // 重置进行中的任务为失败（防止应用关闭时未完成的任务）：
    //   - downloading/pending：下载中断
    //   - parsing：小红书笔记解析中断（隐藏窗口已销毁，无法继续解析）
    const inProgress = task.status === 'downloading' || task.status === 'pending' || task.status === 'parsing';
    return {
      ...task,
      status: inProgress ? 'failed' : task.status,
      error: inProgress ? '应用关闭时任务中断' : task.error,
    };
  });
  for (const task of downloadTasks) rememberDownloadPath(task.savePath);
}

// 保存下载任务到持久化存储
function saveDownloadTasks() {
  // 过滤掉不可序列化的对象
  const serializableTasks = downloadTasks.map(task => {
    const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
    return serializableTask;
  });
  db.saveDownloadTasks(serializableTasks);
}

// 执行图集下载（一个任务 -> 一个文件夹 -> 依次下载所有图片/视频）
async function executeAlbumDownload(task) {
  const { id, videoInfo, platform, albumItems } = task;
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;
  const itemResults = new Array(albumItems.length);

  try {
    console.log('[Album Download] 开始下载图集，共', albumItems.length, '张');
    throwIfTaskAborted(task, signal);

    const baseTitle = sanitizeWindowsFilename(videoInfo?.title || '图集', '图集').slice(0, 80);
    const downloadDir = task.customDir || getDownloadDir({ ...videoInfo, platform });
    let albumDir = task.albumDir;
    if (!albumDir && typeof task.savePath === 'string' && path.isAbsolute(task.savePath)) {
      albumDir = task.savePath;
    }
    if (!albumDir) {
      const desiredFolder = sanitizeWindowsFilename(
        task.albumFolderName || `${baseTitle}_${Date.now().toString(36)}`,
        '图集',
      );
      albumDir = reserveUniquePath(resolveInsideRoot(downloadDir, desiredFolder));
      task.albumFolderName = path.basename(albumDir);
    } else {
      albumDir = path.resolve(albumDir);
      task.albumFolderName = path.basename(albumDir);
    }
    fs.mkdirSync(albumDir, { recursive: true });
    task.albumDir = albumDir;
    task.savePath = albumDir;

    const totalItems = albumItems.length;
    task.totalBytes = totalItems;
    saveDownloadTasks();

    const describeItem = index => {
      const rawItem = albumItems[index];
      const item = rawItem && typeof rawItem === 'object' ? rawItem : { url: rawItem };
      const itemUrl = String(item.url || item.videoUrl || '').trim();
      const requestedExt = item.type === 'video' ? '.mp4' : String(item.ext || '.jpg');
      const normalizedExt = /^\.[A-Za-z0-9]{1,8}$/.test(requestedExt) ? requestedExt : '.jpg';
      const seq = String(index + 1).padStart(Math.max(2, String(totalItems).length), '0');
      const itemFilename = sanitizeWindowsFilename(`${baseTitle}_${seq}${normalizedExt}`, `item_${seq}${normalizedExt}`);
      return {
        index,
        itemUrl,
        itemSavePath: resolveInsideRoot(albumDir, itemFilename),
      };
    };

    const failedIndexes = new Set(
      (Array.isArray(task.failedAlbumItems) ? task.failedAlbumItems : [])
        .map(item => Number(item?.index))
        .filter(index => Number.isInteger(index) && index >= 0 && index < totalItems),
    );
    const targetedRetry = failedIndexes.size > 0;
    const indexesToDownload = new Set(targetedRetry
      ? failedIndexes
      : albumItems.map((_, index) => index));

    if (targetedRetry) {
      for (let index = 0; index < totalItems; index += 1) {
        if (indexesToDownload.has(index)) continue;
        const descriptor = describeItem(index);
        try {
          await verifyNonEmptyFile(descriptor.itemSavePath);
          itemResults[index] = {
            index,
            url: descriptor.itemUrl,
            path: descriptor.itemSavePath,
            ok: true,
          };
        } catch (_) {
          indexesToDownload.add(index);
        }
      }
    }

    for (const i of [...indexesToDownload].sort((a, b) => a - b)) {
      throwIfTaskAborted(task, signal);
      const descriptor = describeItem(i);
      console.log(`[Album Download] 下载第 ${i + 1}/${totalItems} 项:`, path.basename(descriptor.itemSavePath));

      try {
        if (!descriptor.itemUrl) throw createCodedError('ALBUM_ITEM_INVALID', '下载地址为空');
        const response = await axios.get(descriptor.itemUrl, {
          responseType: 'stream',
          headers: { ...getDownloadHeaders(platform), ...(task.headers || {}) },
          timeout: 60000,
          signal,
        });
        await downloadHttpResponse({
          response,
          finalPath: descriptor.itemSavePath,
          taskId: `${id}-${i}`,
          signal,
        });
        itemResults[i] = {
          index: i,
          url: descriptor.itemUrl,
          path: descriptor.itemSavePath,
          ok: true,
        };
      } catch (itemErr) {
        if (isDownloadAbort(itemErr, task, signal)) throw createDownloadAbortError();
        console.error(`[Album Download] 第 ${i + 1} 张失败:`, itemErr.message);
        itemResults[i] = {
          index: i,
          url: descriptor.itemUrl,
          path: descriptor.itemSavePath,
          ok: false,
          error: itemErr?.message || '下载失败',
        };
      }

      task.albumIndex = i + 1;
      const currentSucceeded = itemResults.filter(result => result?.ok === true).length;
      task.receivedBytes = currentSucceeded;
      task.progress = Math.floor((currentSucceeded / totalItems) * 100);
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('download-progress', {
          id,
          progress: task.progress,
          receivedBytes: currentSucceeded,
          totalBytes: totalItems,
        });
      }
      saveDownloadTasks();
    }

    throwIfTaskAborted(task, signal);
    for (let index = 0; index < totalItems; index += 1) {
      if (itemResults[index]) continue;
      const descriptor = describeItem(index);
      itemResults[index] = {
        index,
        url: descriptor.itemUrl,
        path: descriptor.itemSavePath,
        ok: false,
        error: '项目未下载',
      };
    }

    const summary = summarizeItems(itemResults);
    task.failedAlbumItems = summary.failures.map(result => ({
      index: result.index,
      url: result.url,
      error: result.error || '下载失败',
    }));
    task.receivedBytes = summary.succeeded;
    task.totalBytes = totalItems;
    task.progress = summary.status === 'completed'
      ? 100
      : Math.floor((summary.succeeded / totalItems) * 100);
    task.filename = `${baseTitle}（${totalItems}张）`;
    await finalizeDownloadTask(task, summary.status, {
      progress: task.progress,
      receivedBytes: summary.succeeded,
      totalBytes: totalItems,
      error: summary.failed > 0 ? `${summary.failed} 个项目下载失败` : null,
    });
  } catch (error) {
    console.error('[Album Download] 失败:', error.message);
    if (TERMINAL.has(task.status)) throw error;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    await finalizeDownloadTask(task, status, {
      error: status === 'failed' ? (error?.message || '图集下载失败') : null,
    });
  }
}

// 执行 B站 DASH 下载（视频流+音频流分离，下载后用 ffmpeg 合并成单个 mp4）
async function executeDashDownload(task) {
  const { id, videoInfo, platform, dashVideoUrl, dashAudioUrl } = task;
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;
  let tmpDir = null;
  let outputPartPath = null;

  try {
    throwIfTaskAborted(task, signal);
    if (!ffmpegPath) throw new Error('ffmpeg 未安装，无法合并 DASH 流');

    const baseTitle = sanitizeWindowsFilename(videoInfo?.title || 'B站视频', 'B站视频').slice(0, 100);
    const downloadDir = task.customDir || getDownloadDir({ ...videoInfo, platform });
    fs.mkdirSync(downloadDir, { recursive: true });

    if (!task.savePath) {
      task.savePath = reserveDownloadPath(resolveInsideRoot(downloadDir, `${baseTitle}.mp4`));
      task.filename = path.basename(task.savePath);
    } else if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
    }

    const safeTaskId = String(task.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 48) || 'task';
    tmpDir = resolveInsideRoot(downloadDir, `${baseTitle}_dash_tmp_${safeTaskId}`);
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await fs.promises.mkdir(tmpDir, { recursive: true });
    task.tmpDir = tmpDir;

    const videoTmpPath = path.join(tmpDir, 'video.m4s');
    const audioTmpPath = path.join(tmpDir, 'audio.m4s');
    outputPartPath = createPartPath(task.savePath, id);
    await fs.promises.rm(outputPartPath, { force: true });

    const downloadHeaders = { ...getDownloadHeaders(platform), ...(task.headers || {}) };
    let completedBytes = 0;
    task.receivedBytes = 0;
    task.totalBytes = 0;

    const downloadStream = async (url, targetPath, progressStart, progressEnd) => {
      throwIfTaskAborted(task, signal);
      const response = await axios.get(url, {
        responseType: 'stream',
        headers: downloadHeaders,
        timeout: 120000,
        signal,
      });
      const expectedBytes = Number(response.headers?.['content-length']) || 0;
      task.totalBytes += expectedBytes;
      const published = await downloadHttpResponse({
        response,
        finalPath: targetPath,
        taskId: `${id}-${path.basename(targetPath)}`,
        signal,
        onProgress: ({ receivedBytes, progress }) => {
          task.receivedBytes = completedBytes + receivedBytes;
          task.progress = Math.floor(progressStart + ((progress / 100) * (progressEnd - progressStart)));
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('download-progress', {
              id,
              progress: task.progress,
              receivedBytes: task.receivedBytes,
              totalBytes: task.totalBytes,
            });
          }
        },
      });
      completedBytes += published.bytes;
      task.receivedBytes = completedBytes;
    };

    await downloadStream(dashVideoUrl, videoTmpPath, 0, 45);
    await downloadStream(dashAudioUrl, audioTmpPath, 45, 90);
    throwIfTaskAborted(task, signal);

    task.progress = 92;
    const running = runCancellableProcess({
      command: ffmpegPath,
      args: [
        '-nostdin', '-y',
        '-i', videoTmpPath,
        '-i', audioTmpPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-f', 'mp4',
        outputPartPath,
      ],
      signal,
    });
    runtime.childProcess = running.child;
    try {
      await running;
    } finally {
      runtime.childProcess = null;
    }

    throwIfTaskAborted(task, signal);
    const outputBytes = await verifyNonEmptyFile(outputPartPath);
    const outputHandle = await fs.promises.open(outputPartPath, 'r+');
    try {
      await outputHandle.sync();
    } finally {
      await outputHandle.close();
    }
    throwIfTaskAborted(task, signal);
    await fs.promises.rename(outputPartPath, task.savePath);
    outputPartPath = null;

    await finalizeDownloadTask(task, 'completed', {
      progress: 100,
      receivedBytes: outputBytes,
      totalBytes: outputBytes,
      error: null,
    });
  } catch (error) {
    console.error('[DASH Download] 失败:', error?.code || error?.message);
    if (TERMINAL.has(task.status)) throw error;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    const stderrTail = typeof error?.stderr === 'string' ? error.stderr.trim().slice(-500) : '';
    await finalizeDownloadTask(task, status, {
      error: status === 'failed' ? (stderrTail || error?.message || 'DASH 下载失败') : null,
    });
  } finally {
    if (runtime.childProcess) {
      await terminateProcessTree(runtime.childProcess);
      runtime.childProcess = null;
    }
    if (outputPartPath) {
      try { await fs.promises.rm(outputPartPath, { force: true }); } catch (_) {}
    }
    if (tmpDir) {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
    delete task.tmpDir;
  }
}
// 使用 ffmpeg 直接处理 HLS/MPD 清单，避免主进程手工解析并缓存全部分片。
async function executeManifestDownload(task, manifestUrl, label) {
  const { id, videoInfo, platform } = task;
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;
  let partPath = null;

  try {
    throwIfTaskAborted(task, signal);
    if (!ffmpegPath) throw new Error('ffmpeg 未安装，无法处理播放清单');

    const baseTitle = sanitizeWindowsFilename(videoInfo?.title || '视频', '视频').slice(0, 100);
    const downloadDir = task.customDir || getDownloadDir({ ...videoInfo, platform });
    fs.mkdirSync(downloadDir, { recursive: true });

    if (!task.savePath) {
      task.savePath = reserveDownloadPath(resolveInsideRoot(downloadDir, `${baseTitle}.mp4`));
      task.filename = path.basename(task.savePath);
    } else if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
    }

    partPath = createPartPath(task.savePath, id);
    await fs.promises.rm(partPath, { force: true });
    const downloadHeaders = { ...getDownloadHeaders(platform), ...(task.headers || {}) };
    const args = buildManifestFfmpegArgs({
      manifestUrl,
      headers: downloadHeaders,
      partPath,
    });

    task.progress = 5;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('download-progress', {
        id,
        progress: task.progress,
        receivedBytes: 0,
        totalBytes: 0,
      });
    }

    let progressReported = false;
    const running = runCancellableProcess({
      command: ffmpegPath,
      args,
      signal,
      onStderr: chunk => {
        if (!progressReported && /\btime=/.test(chunk.toString())) {
          progressReported = true;
          task.progress = 80;
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('download-progress', {
              id,
              progress: task.progress,
              receivedBytes: task.receivedBytes || 0,
              totalBytes: task.totalBytes || 0,
            });
          }
        }
      },
    });
    runtime.childProcess = running.child;
    try {
      await running;
    } finally {
      runtime.childProcess = null;
    }

    throwIfTaskAborted(task, signal);
    const outputBytes = await verifyNonEmptyFile(partPath);
    const handle = await fs.promises.open(partPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfTaskAborted(task, signal);
    await fs.promises.rename(partPath, task.savePath);
    partPath = null;

    await finalizeDownloadTask(task, 'completed', {
      progress: 100,
      receivedBytes: outputBytes,
      totalBytes: outputBytes,
      error: null,
    });
  } catch (error) {
    console.error(`[${label} Download] 失败:`, error?.code || error?.message);
    if (TERMINAL.has(task.status)) throw error;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    const stderrTail = typeof error?.stderr === 'string' ? error.stderr.trim().slice(-500) : '';
    await finalizeDownloadTask(task, status, {
      error: status === 'failed'
        ? (stderrTail || error?.message || `${label} 下载失败`)
        : null,
    });
  } finally {
    if (runtime.childProcess) {
      await terminateProcessTree(runtime.childProcess);
      runtime.childProcess = null;
    }
    if (partPath) {
      try { await fs.promises.rm(partPath, { force: true }); } catch (_) {}
    }
  }
}

// RTMP 直播必须交给 ffmpeg 录制；普通 HTTP-FLV 仍走可校验的流式下载路径。
async function executeLiveRecording(task) {
  const { id } = task;
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;
  let partPath = null;

  try {
    throwIfTaskAborted(task, signal);
    if (!ffmpegPath) throw new Error('ffmpeg 未安装，无法录制 RTMP 直播');

    if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
    }
    fs.mkdirSync(path.dirname(task.savePath), { recursive: true });
    partPath = createPartPath(task.savePath, id);
    await fs.promises.rm(partPath, { force: true });

    const outputFormat = path.extname(task.savePath).toLowerCase() === '.mp4' ? 'mp4' : 'flv';
    const running = runCancellableProcess({
      command: ffmpegPath,
      args: [
        '-hide_banner', '-loglevel', 'info', '-nostdin', '-y',
        '-i', task.url,
        '-c', 'copy',
        '-f', outputFormat,
        partPath,
      ],
      signal,
      onStderr: chunk => {
        if (!/\btime=/.test(chunk.toString())) return;
        task.progress = Math.max(1, task.progress || 0);
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('download-progress', {
            id,
            status: 'downloading',
            progress: task.progress,
            receivedBytes: task.receivedBytes || 0,
            totalBytes: 0,
          });
        }
      },
    });
    runtime.childProcess = running.child;
    try {
      await running;
    } finally {
      runtime.childProcess = null;
    }

    throwIfTaskAborted(task, signal);
    const outputBytes = await verifyNonEmptyFile(partPath);
    const handle = await fs.promises.open(partPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfTaskAborted(task, signal);
    await fs.promises.rename(partPath, task.savePath);
    partPath = null;

    await finalizeDownloadTask(task, 'completed', {
      progress: 100,
      receivedBytes: outputBytes,
      totalBytes: outputBytes,
      error: null,
    });
  } catch (error) {
    if (TERMINAL.has(task.status)) throw error;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    const stderrTail = typeof error?.stderr === 'string' ? error.stderr.trim().slice(-500) : '';
    await finalizeDownloadTask(task, status, {
      error: status === 'failed' ? (stderrTail || error?.message || '直播录制失败') : null,
    });
  } finally {
    if (runtime.childProcess) {
      await terminateProcessTree(runtime.childProcess);
      runtime.childProcess = null;
    }
    if (partPath) {
      try { await fs.promises.rm(partPath, { force: true }); } catch (_) {}
    }
  }
}

async function executeM3u8Download(task) {
  const { m3u8Url } = task;
  return executeManifestDownload(task, m3u8Url, 'HLS');
}

async function executeMpdDownload(task) {
  const { mpdUrl } = task;
  return executeManifestDownload(task, mpdUrl, 'MPD');
}
// 判断 yt-dlp 下载的 URL 是否需要走代理（被墙站点才需要）
// 与 youtube.js 的 needsProxy 保持一致
function ytdlNeedsProxy(url) {
  const u = (url || '').toLowerCase();
  const proxySites = [
    'youtube.com', 'youtu.be', 'instagram.com', 'twitter.com', 'x.com',
    'facebook.com', 'fb.watch', 'reddit.com', 'vimeo.com', 'twitch.tv',
    'dailymotion.com', 'pinterest.com', 'streamable.com',
  ];
  for (const s of proxySites) {
    if (u.includes(s)) return true;
  }
  return false;
}

// 执行 yt-dlp 下载（YouTube / Instagram / Twitter / TikTok 国际版 / Reddit 等）：
// yt-dlp 负责下载视频流+音频流并用 ffmpeg 合并为单个 mp4（高分辨率多为 DASH，音视频分离）
// 这里通过 spawn 调用 yt-dlp，解析其 --newline 输出的进度行更新到 UI
async function executeYtdlDownload(task) {
  const { id, videoInfo, platform, ytdlUrl, ytdlMaxHeight } = task;
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;
  const credentialCookieFiles = [];
  let reportedOutputPath = null;

  try {
    console.log('[yt-dlp Download] 开始下载:', ytdlUrl, ytdlMaxHeight ? `最高${ytdlMaxHeight}p` : '(最高画质)');
    throwIfTaskAborted(task, signal);

    if (!ytDlpPath) {
      throw new Error('未找到 yt-dlp 可执行文件，无法下载视频');
    }
    if (!ffmpegPath) {
      throw new Error('ffmpeg 未安装，无法合并视频流和音频流');
    }

    const baseTitle = (videoInfo?.title || '视频').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 80);
    // 优先用 task.customDir（主页下载传入的「用户名--主页」文件夹，与其他主页下载一致），
    // 否则走通用下载目录
    const downloadDir = task.customDir || getDownloadDir({ ...videoInfo, platform });
    if (!task.savePath) {
      task.savePath = reserveDownloadPath(resolveInsideRoot(downloadDir, `${baseTitle}.mp4`));
      task.filename = path.basename(task.savePath);
    } else if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
    }
    const reservedDirectory = path.dirname(task.savePath);
    const reservedStem = path.basename(task.savePath, path.extname(task.savePath));

    task.totalBytes = 0;
    task.receivedBytes = 0;
    task.progress = 0;

    // yt-dlp 参数：
    //   -f bestvideo+bestaudio / best      选最佳视频流+音频流（无合并格式时回退 best）
    //   --merge-output-format mp4          合并为 mp4
    //   --ffmpeg-location <ffmpeg.exe>     用内置 ffmpeg 合并
    //   --newline                          每行进度单独输出（便于解析，不用 \r 覆盖）
    //   --no-playlist                      只下载单个视频
    //   -o <path>                          输出路径
    // 若用户选了清晰度（ytdlMaxHeight>0），用 bestvideo[height<=N]+bestaudio 限制最高画质
    const heightLimit = ytdlMaxHeight && ytdlMaxHeight > 0 ? `[height<=${ytdlMaxHeight}]` : '';
    const formatSelector = heightLimit
      ? `bestvideo${heightLimit}+bestaudio/best${heightLimit}`
      : 'bestvideo+bestaudio/best';
    const outputTemplate = path.join(reservedDirectory, `${reservedStem}.%(ext)s`);
    // 智能代理：被墙站点（YouTube/Instagram/Twitter 等）走代理，TikTok/B站等直连
    const needsProxy = ytdlNeedsProxy(ytdlUrl);
    const args = [
      '--no-warnings',
      '--no-playlist',
    ];
    if (needsProxy) args.push('--proxy', ytDlpProxy);
    // B 站：若已在「登录平台账号」登录哔哩哔哩（cookie_bilibili 有 SESSDATA），
    // 把登录 cookie 传给 yt-dlp 以解锁高清晰度（未登录默认只能下到 480p）
    if (platform === 'bilibili') {
      try {
        const biliCookie = String(db.getKV('cookie_bilibili', '') || '').trim();
        const biliArgs = buildCookieArgs(biliCookie, {
          platform: 'bilibili',
          domain: '.bilibili.com',
        });
        if (biliArgs.length) {
          credentialCookieFiles.push(biliArgs[1]);
          args.push(...biliArgs);
        }
      } catch (_) { /* 忽略 cookie 读取失败 */ }
    }
    // 小红书：主页批量任务由 yt-dlp 直接解析笔记页，需要登录 cookie（web_session 等）
    // 才能拿到完整视频流；未登录则不带（yt-dlp 失败后会自动回退 feed 解析）。
    if (platform === 'xiaohongshu') {
      try {
        const xhsCookie = String(db.getKV('cookie_xiaohongshu', '') || '').trim();
        const xhsArgs = buildCookieArgs(xhsCookie, {
          platform: 'xiaohongshu',
          domain: '.xiaohongshu.com',
        });
        if (xhsArgs.length) {
          credentialCookieFiles.push(xhsArgs[1]);
          args.push(...xhsArgs);
        }
      } catch (_) { /* 忽略 cookie 读取失败 */ }
    }
    // YouTube：带登录 cookie（--cookies 临时文件），绕开 bot 检测
    // （"Sign in to confirm you're not a bot"）。解析阶段已经验证过 cookie，
    // 下载阶段再带一次保证能拿到完整清晰度；未登录则不带（行为与之前一致）。
    if (platform === 'youtube' || /youtube\.com|youtu\.be/i.test(ytdlUrl || '')) {
      try {
        const ytCookie = String(db.getKV('cookie_youtube', '') || '').trim();
        const ytArgs = buildYoutubeCookieArgs(ytCookie);
        if (ytArgs.length) {
          credentialCookieFiles.push(ytArgs[1]);
          args.push(...ytArgs);
        }
      } catch (_) { /* 忽略 cookie 读取失败 */ }
    }
    args.push(
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegPath,
      '--newline',
      '--print', `after_move:${YTDLP_OUTPUT_MARKER}%(filepath)s`,
      '-o', outputTemplate,
      ytdlUrl,
    );

    console.log('[yt-dlp Download] 启动外部下载器（敏感参数已隐藏）:', needsProxy ? '代理' : '直连');

    let phase = 'video';
    let seenVideoProgress = false;
    const updateProgress = pct => {
      const start = phase === 'video' ? 0 : (phase === 'audio' ? 45 : 90);
      const end = phase === 'video' ? 45 : (phase === 'audio' ? 90 : 99);
      const progress = Math.floor(start + ((pct / 100) * (end - start)));
      task.progress = Math.min(progress, end);
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('download-progress', {
          id,
          progress: task.progress,
          receivedBytes: task.receivedBytes,
          totalBytes: task.totalBytes,
        });
      }
    };
    const handleLine = line => {
      const text = line.toString();
      const printedOutputPath = parseYtdlpOutputLine(text);
      if (printedOutputPath) {
        reportedOutputPath = printedOutputPath;
        return;
      }
      if (text.includes('[download] Destination:') || text.includes('Destination:')) {
        if (phase === 'video' && seenVideoProgress) phase = 'audio';
        return;
      }
      if (text.includes('[Merger]') || text.includes('Merging formats')) {
        phase = 'merge';
        task.progress = 92;
        return;
      }
      const match = text.match(/\[download\]\s+([0-9.]+)%/);
      if (match) {
        if (phase === 'video') seenVideoProgress = true;
        updateProgress(parseFloat(match[1]));
      }
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    const consumeLines = (chunk, isStdout) => {
      let buffer = (isStdout ? stdoutBuf : stderrBuf) + chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handleLine(line);
      }
      if (isStdout) stdoutBuf = buffer;
      else stderrBuf = buffer;
    };

    const running = runCancellableProcess({
      command: ytDlpPath,
      args,
      env: { ...process.env, YTDL_NO_UPDATE: '1' },
      signal,
      onStdout: chunk => consumeLines(chunk, true),
      onStderr: chunk => consumeLines(chunk, false),
    });
    runtime.childProcess = running.child;
    task.ytdlProcess = running.child;
    try {
      await running;
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (stderrBuf.trim()) handleLine(stderrBuf);
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr : stderrBuf;
      if (error?.code === 'PROCESS_EXIT_NONZERO') {
        if (stderr.includes('Unable to download')) error.message = '无法访问该站点，请检查代理是否可用';
        if (stderr.includes('Video unavailable')) error.message = '视频不可用或已被删除';
      }
      throw error;
    } finally {
      runtime.childProcess = null;
      delete task.ytdlProcess;
    }

    throwIfTaskAborted(task, signal);
    if (!reportedOutputPath) {
      throw createCodedError('OUTPUT_MISSING', 'yt-dlp 未报告最终输出文件');
    }

    const resolvedOutputPath = path.isAbsolute(reportedOutputPath)
      ? path.resolve(reportedOutputPath)
      : path.resolve(reservedDirectory, reportedOutputPath);
    const relativeOutput = path.relative(path.resolve(reservedDirectory), resolvedOutputPath);
    if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeOutput)) {
      throw createCodedError('OUTPUT_PATH_INVALID', 'yt-dlp 报告了下载目录之外的输出文件');
    }
    const outputBytes = await verifyNonEmptyFile(resolvedOutputPath).catch(error => {
      throw createCodedError('OUTPUT_MISSING', 'yt-dlp 未生成有效输出文件', error);
    });
    if (downloadPathKey(task.savePath) !== downloadPathKey(resolvedOutputPath)) {
      releaseDownloadPath(task.savePath);
      rememberDownloadPath(resolvedOutputPath);
      task.savePath = resolvedOutputPath;
      task.filename = path.basename(resolvedOutputPath);
    }
    await finalizeDownloadTask(task, 'completed', {
      progress: 100,
      receivedBytes: outputBytes,
      totalBytes: outputBytes,
      error: null,
    });

  } catch (error) {
    console.error('[yt-dlp Download] 失败:', error.message);
    if (TERMINAL.has(task.status)) throw error;
    delete task.ytdlProcess;
    runtime.childProcess = null;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    // 小红书主页任务：yt-dlp 解析/下载失败（非用户停止）时不标记失败，
    // 自动回退到隐藏窗口 feed 解析（登录态直链），图集笔记也由该链路承接。
    if (status === 'failed' && canFallbackToXhsFeed(task)) {
      console.warn('[yt-dlp Download] 小红书任务回退 feed 解析:', task.id, error?.message || '');
      startXhsFeedFallback(task);
      return;
    }
    await finalizeDownloadTask(task, status, {
      error: status === 'failed' ? (error?.message || 'yt-dlp 下载失败') : null,
    });
  } finally {
    for (const file of credentialCookieFiles) cleanupCookieFile(file);
  }
}


// 执行红果短剧下载（解析直链 -> 流式下载 -> CENC-AES-CTR 解密）
async function executeHongguoDownload(task) {
  const { id, hongguoInfo, filename } = task;
  const { vid, series_title, vid_index } = hongguoInfo || {};
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;
  let encryptedPath = null;
  let outputPartPath = null;

  try {
    console.log(`[Hongguo Download] 开始下载《${series_title}》第${vid_index}集:`, vid);
    throwIfTaskAborted(task, signal);

    const playInfo = await hongguo.fetchPlayUrlSingle(vid);
    throwIfTaskAborted(task, signal);
    if (!playInfo || !playInfo.url) {
      throw new Error('未获取到有效播放地址');
    }

    const settings = db.getKV('settings', {}) || {};
    const fallback = app.getPath('downloads');
    const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : fallback;
    const seriesFolder = sanitizeFolderName(series_title) || '未命名短剧';
    const downloadDir = task.customDir || path.join(root, '红果短剧', seriesFolder);
    fs.mkdirSync(downloadDir, { recursive: true });

    if (!task.savePath) {
      const safeFilename = sanitizeWindowsFilename(filename, 'hongguo.mp4');
      task.savePath = reserveDownloadPath(resolveInsideRoot(downloadDir, safeFilename));
      task.filename = path.basename(task.savePath);
    } else if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
      saveDownloadTasks();
    }

    const finalPath = task.savePath;
    encryptedPath = createPartPath(finalPath, `${id}-encrypted`);
    outputPartPath = createPartPath(finalPath, id);
    await fs.promises.rm(encryptedPath, { force: true });
    await fs.promises.rm(outputPartPath, { force: true });

    const headers = {
      'User-Agent': hongguo.UA,
      ...(task.headers || {}),
    };
    let response;
    try {
      response = await axios.get(playInfo.url, {
        responseType: 'stream',
        headers,
        timeout: 60000,
        signal,
      });
    } catch (err) {
      if (!isDownloadAbort(err, task, signal) && err.response?.status === 403) {
        response = await axios.get(playInfo.url, {
          responseType: 'stream',
          headers: { ...headers, Referer: hongguo.VIDEO_REFERER },
          timeout: 60000,
          signal,
        });
      } else {
        throw err;
      }
    }

    await downloadHttpResponse({
      response,
      finalPath: encryptedPath,
      taskId: `${id}-source`,
      signal,
      onProgress: ({ receivedBytes, totalBytes, progress }) => {
        task.receivedBytes = receivedBytes;
        task.totalBytes = totalBytes;
        task.progress = Math.min(75, Math.floor(progress * 0.75));
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('download-progress', {
            id,
            progress: task.progress,
            receivedBytes,
            totalBytes,
          });
        }
      },
    });
    throwIfTaskAborted(task, signal);

    if (playInfo.spadeA) {
      console.log('[Hongguo Download] 正在派生 AES Key 并解密 MP4...');
      const key = hongguo.deriveKey(playInfo.spadeA);
      if (!key) throw new Error('Key 派生失败');
      await runHongguoDecryptWorker({
        inputPath: encryptedPath,
        outputPath: outputPartPath,
        key,
        signal,
        onProgress: progress => {
          task.progress = 75 + Math.floor(Math.min(100, progress) * 0.24);
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('download-progress', {
              id,
              progress: task.progress,
              receivedBytes: task.receivedBytes,
              totalBytes: task.totalBytes,
            });
          }
        },
      });
    } else {
      await fs.promises.rename(encryptedPath, outputPartPath);
      encryptedPath = null;
    }

    throwIfTaskAborted(task, signal);
    const outputBytes = await verifyNonEmptyFile(outputPartPath);
    const outputHandle = await fs.promises.open(outputPartPath, 'r+');
    try {
      await outputHandle.sync();
    } finally {
      await outputHandle.close();
    }
    throwIfTaskAborted(task, signal);
    await fs.promises.rename(outputPartPath, finalPath);
    outputPartPath = null;
    await finalizeDownloadTask(task, 'completed', {
      progress: 100,
      receivedBytes: outputBytes,
      totalBytes: outputBytes,
      error: null,
    });

  } catch (error) {
    console.error('[Hongguo Download] 失败:', error.message);
    if (TERMINAL.has(task.status)) throw error;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    await finalizeDownloadTask(task, status, {
      error: status === 'failed' ? (error?.message || '红果下载失败') : null,
    });
  } finally {
    if (encryptedPath) {
      try { await fs.promises.rm(encryptedPath, { force: true }); } catch (_) {}
    }
    if (outputPartPath) {
      try { await fs.promises.rm(outputPartPath, { force: true }); } catch (_) {}
    }
  }
}

// 执行评论下载
async function executeCommentDownload(task) {
  const { id, videoInfo } = task;
  const runtime = installTaskAbortRuntime(task);
  const signal = runtime.controller.signal;

  try {
    console.log('[Comment Download] 开始获取评论:', videoInfo.awemeId);
    throwIfTaskAborted(task, signal);
    if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
      saveDownloadTasks();
    }

    const allComments = [];
    const seenIds = new Set();          // 评论去重（避免接口循环返回重复数据）
    let cursor = 0;
    let prevCursor = 0;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 500;               // 最多获取 500 页（配合下方保护可放心放大）
    const MAX_CONSECUTIVE_EMPTY = 15;   // 连续空页容忍（抖音接口会中途返回空页但 has_more=1）
    const MAX_NO_NEW = 3;               // 连续 N 页无新增评论则停（接口循环重复保护）
    let consecutiveEmpty = 0;
    let noNewStreak = 0;

    // 循环获取所有评论
    while (hasMore && pageCount < maxPages) {
      throwIfTaskAborted(task, signal);
      pageCount++;

      const result = await douyinAPI.getVideoComments(videoInfo.awemeId, cursor, 50);
      throwIfTaskAborted(task, signal);

      console.log(`[Comment Download] 第${pageCount}页原始响应:`, JSON.stringify(result).substring(0, 500));

      // 处理不同的API响应结构
      let comments = null;
      let nextCursor = cursor;
      let rawHasMore = false;

      if (result) {
        // 尝试多种可能的数据结构
        if (result.comments && Array.isArray(result.comments)) {
          comments = result.comments;
          nextCursor = Number(result.cursor) || cursor;
          rawHasMore = result.has_more;
        } else if (result.data && result.data.comments && Array.isArray(result.data.comments)) {
          comments = result.data.comments;
          nextCursor = Number(result.data.cursor) || cursor;
          rawHasMore = result.data.has_more;
        } else if (result.comment_list && Array.isArray(result.comment_list)) {
          comments = result.comment_list;
          nextCursor = Number(result.cursor) || cursor;
          rawHasMore = result.has_more;
        }
      }

      // has_more 兜底：字段缺失/异常时，用「接近满页 + 游标前进」推断
      // （抖音评论接口同样存在 has_more 缺失或假空页的情况）
      const listLen = comments ? comments.length : 0;
      const advanced = Number(nextCursor) !== Number(prevCursor);
      let moreData;
      if (rawHasMore === 1 || rawHasMore === true || rawHasMore === '1' || rawHasMore === 'true') {
        moreData = true;
      } else if (rawHasMore === 0 || rawHasMore === false || rawHasMore === '0' || rawHasMore === 'false') {
        moreData = false;
      } else {
        // has_more 缺失：接近满页且游标前进才认为还有
        moreData = listLen >= (50 - 2) && advanced;
      }

      // 去重：只保留新评论
      let newCount = 0;
      if (comments && comments.length > 0) {
        for (const c of comments) {
          const key = c.cid || (c.comment_id + '_' + (c.user?.uid || ''));
          if (key && !seenIds.has(key)) {
            seenIds.add(key);
            allComments.push(c);
            newCount++;
          }
        }
        consecutiveEmpty = 0; // 拿到数据就清零空页计数
      } else {
        consecutiveEmpty++;
      }

      // 连续无新增评论计数
      if (newCount === 0) {
        noNewStreak++;
      } else {
        noNewStreak = 0;
      }

      console.log(`[Comment Download] 第${pageCount}页: 本页${listLen}条, 新增${newCount}条, 累计${allComments.length}条, cursor=${nextCursor}(prev=${prevCursor}), rawHasMore=${rawHasMore}, moreData=${moreData}, 连续空页=${consecutiveEmpty}, 无新增连续=${noNewStreak}`);

      // 游标更新
      prevCursor = cursor;
      cursor = nextCursor;

      // 终止判断（按优先级）
      // 1. has_more 明确为 false 且本页有数据 -> 正常结束
      if (moreData === false && consecutiveEmpty === 0) {
        console.log('[Comment Download] has_more=false，正常结束');
        hasMore = false;
        break;
      }
      // 2. 游标停滞（游标不再前进）-> 停
      if (Number(nextCursor) === Number(prevCursor) && pageCount > 1) {
        console.log('[Comment Download] 游标停滞，停止');
        hasMore = false;
        break;
      }
      // 3. 连续无新增评论超过阈值 -> 停（接口循环重复保护）
      if (noNewStreak >= MAX_NO_NEW) {
        console.log(`[Comment Download] 连续${MAX_NO_NEW}页无新增，停止`);
        hasMore = false;
        break;
      }
      // 4. 连续空页超过容忍阈值 -> 停
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
        console.log(`[Comment Download] 连续${MAX_CONSECUTIVE_EMPTY}页空，停止`);
        hasMore = false;
        break;
      }

      hasMore = moreData;

      const progress = Math.min(pageCount * 2, 99); // Approximate progress
      task.progress = progress;

      // 通知前端进度
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-progress', {
          id,
          progress,
          receivedBytes: allComments.length,
          totalBytes: 0,
        });
      }

      // 添加小延迟避免请求过快
      if (hasMore) {
        await waitForDelay(500, signal);
      }
    }

    console.log(`[Comment Download] 顶层评论采集完成，共 ${allComments.length} 条，开始拉取子评论...`);

    // 拉取楼中楼子评论（reply_comment_total > 0 的评论）
    const replyComments = [];
    let replyTotal = 0;
    for (let i = 0; i < allComments.length; i++) {
      throwIfTaskAborted(task, signal);
      const c = allComments[i];
      const replyCount = c.reply_comment_total || 0;
      if (replyCount > 0 && c.cid) {
        replyTotal += replyCount;
        try {
          let rcursor = 0;
          let rHasMore = true;
          let rPage = 0;
          const rSeen = new Set();
          while (rHasMore && rPage < 50) { // 单条评论子评论最多 50 页
            throwIfTaskAborted(task, signal);
            rPage++;
            const rResult = await douyinAPI.getCommentReplies(videoInfo.awemeId, c.cid, rcursor, 20);
            throwIfTaskAborted(task, signal);
            let rComments = null;
            let rNextCursor = rcursor;
            let rRawMore = false;
            if (rResult) {
              if (rResult.comments && Array.isArray(rResult.comments)) {
                rComments = rResult.comments;
                rNextCursor = Number(rResult.cursor) || rcursor;
                rRawMore = rResult.has_more;
              } else if (rResult.data && rResult.data.comments) {
                rComments = rResult.data.comments;
                rNextCursor = Number(rResult.data.cursor) || rcursor;
                rRawMore = rResult.data.has_more;
              }
            }
            if (!rComments || rComments.length === 0) break;
            for (const rc of rComments) {
              const rkey = rc.cid || (rc.comment_id + '_' + (rc.user?.uid || ''));
              if (rkey && !rSeen.has(rkey)) {
                rSeen.add(rkey);
                // 标记父评论，便于导出时区分
                rc._parent_cid = c.cid;
                rc._parent_nickname = c.user?.nickname || '';
                replyComments.push(rc);
              }
            }
            // 游标比较必须在赋值前进行，否则 rNextCursor 与 rcursor 永远相等
            const cursorAdvanced = Number(rNextCursor) !== Number(rcursor);
            rcursor = rNextCursor;
            // has_more 为真且游标前进才继续；第一页无条件信任 has_more（游标可能从 0 起步）
            rHasMore = (rRawMore === 1 || rRawMore === true) && (cursorAdvanced || rPage === 1);
            if (!cursorAdvanced && rPage > 1) break; // 游标停滞
            if (rHasMore) await waitForDelay(300, signal);
          }
        } catch (e) {
          if (isDownloadAbort(e, task, signal)) throw e;
          console.warn(`[Comment Download] 子评论拉取失败(cid=${c.cid}):`, e.message);
        }
        // 每条评论的子评论之间稍作间隔
        await waitForDelay(200, signal);
      }
    }

    console.log(`[Comment Download] 子评论拉取完成，共 ${replyComments.length} 条（预计 ${replyTotal} 条）`);

    throwIfTaskAborted(task, signal);
    // 转换为CSV格式（顶层评论 + 子评论）
    const csvContent = convertCommentsToCSV(allComments, replyComments);
    const csvBuffer = Buffer.from('\uFEFF' + csvContent, 'utf-8'); // Add BOM for Excel

    const published = await writeStreamToPart({
      readable: Readable.from([csvBuffer]),
      finalPath: task.savePath,
      taskId: id,
      expectedLength: csvBuffer.length,
      signal,
    });
    await finalizeDownloadTask(task, 'completed', {
      progress: 100,
      totalBytes: published.bytes,
      receivedBytes: published.bytes,
      error: null,
    });

  } catch (error) {
    console.error('[Comment Download] 失败:', error.message);
    if (TERMINAL.has(task.status)) throw error;
    const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
    const status = isDownloadAbort(error, task, signal)
      ? (requestedTerminal === 'deleted' ? 'deleted' : 'stopped')
      : 'failed';
    await finalizeDownloadTask(task, status, {
      error: status === 'failed' ? (error?.message || '评论下载失败') : null,
    });
  }
}

// 将评论转换为CSV格式（顶层评论 + 楼中楼子评论）
function convertCommentsToCSV(comments, replyComments = []) {
  const headers = ['类型', '评论ID', '用户昵称', '抖音号', '评论内容', '点赞数', '回复数', '发布时间', 'IP属地', '父评论昵称'];
  const rows = [headers.join(',')];

  // 顶层评论
  comments.forEach(comment => {
    const row = [
      escapeCSV('评论'),
      escapeCSV(comment.cid || ''),
      escapeCSV(comment.user?.nickname || ''),
      escapeCSV(comment.user?.unique_id || ''),
      escapeCSV(comment.text || ''),
      comment.digg_count || 0,
      comment.reply_comment_total || 0,
      comment.create_time ? new Date(comment.create_time * 1000).toLocaleString('zh-CN') : '',
      escapeCSV(comment.ip_label || ''),
      escapeCSV(''),
    ];
    rows.push(row.join(','));
  });

  // 楼中楼子评论
  replyComments.forEach(comment => {
    const row = [
      escapeCSV('回复'),
      escapeCSV(comment.cid || ''),
      escapeCSV(comment.user?.nickname || ''),
      escapeCSV(comment.user?.unique_id || ''),
      escapeCSV(comment.text || ''),
      comment.digg_count || 0,
      comment.reply_comment_total || 0,
      comment.create_time ? new Date(comment.create_time * 1000).toLocaleString('zh-CN') : '',
      escapeCSV(comment.ip_label || ''),
      escapeCSV(comment._parent_nickname || ''),
    ];
    rows.push(row.join(','));
  });

  return rows.join('\n');
}

// CSV值转义
function escapeCSV(value) {
  return escapeSpreadsheetCSVCell(value);
}

// 各平台下载所需的 Referer / User-Agent（避免防盗链拦截）
const PLATFORM_DOWNLOAD_HEADERS = {
  bilibili: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
  },
  xiaohongshu: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Referer': 'https://www.xiaohongshu.com/',
  },
  weibo: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Referer': 'https://weibo.com/',
  },
  kuaishou: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Referer': 'https://www.kuaishou.com/',
  },
  pipixia: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Referer': 'https://h5.pipix.com/',
  },
  xigua: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Referer': 'https://www.ixigua.com/',
  },
  douyin: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Referer': 'https://www.douyin.com/',
  },
  tiktok: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Referer': 'https://www.tiktok.com/explore',
    'Range': 'bytes=0-',
  },
  acfun: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.acfun.cn/',
  },
  haokan: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://haokan.baidu.com/',
  },
  huya: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://v.huya.com/',
  },
  lishipin: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.pearvideo.com/',
  },
};

// 根据平台获取下载请求头（默认使用抖音的头）
function getDownloadHeaders(platform) {
  return PLATFORM_DOWNLOAD_HEADERS[platform] || {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.douyin.com/',
  };
}

async function executeDirectDownload(task) {
  const controller = new AbortController();
  const runtime = {
    controller,
    requestedTerminal: taskCancellationStatuses.get(task) || null,
    completion: null,
  };
  Object.defineProperty(task, 'runtime', {
    value: runtime,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  if (runtime.requestedTerminal || task.cancelled) controller.abort();

  const completion = (async () => {
    let outcome;
    try {
      const downloadHeaders = {
        ...getDownloadHeaders(task.platform || task.videoInfo?.platform),
        ...(task.headers || {}),
      };
      const response = await axios.get(task.url, {
        responseType: 'stream',
        headers: downloadHeaders,
        timeout: 120000,
        signal: controller.signal,
      });
      const rawLength = response.headers?.['content-length'] || 0;
      const totalBytes = Number(rawLength) || 0;
      task.totalBytes = totalBytes;

      const published = await downloadHttpResponse({
        response,
        finalPath: task.savePath,
        taskId: task.id,
        signal: controller.signal,
        onProgress: ({ receivedBytes, totalBytes: expectedBytes, progress }) => {
          task.receivedBytes = receivedBytes;
          task.totalBytes = expectedBytes;
          task.progress = progress;
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('download-progress', {
              id: task.id,
              progress,
              receivedBytes,
              totalBytes: expectedBytes,
            });
          }
        },
      });

      outcome = {
        status: 'completed',
        patch: {
          progress: 100,
          receivedBytes: published.bytes,
          totalBytes: totalBytes || published.bytes,
          error: null,
        },
      };
    } catch (error) {
      const requestedTerminal = runtime.requestedTerminal || taskCancellationStatuses.get(task);
      const wasAborted = controller.signal.aborted
        || error?.code === 'DOWNLOAD_ABORTED'
        || error?.code === 'ERR_CANCELED'
        || axios.isCancel(error);
      if (wasAborted) {
        outcome = {
          status: requestedTerminal === 'deleted' ? 'deleted' : 'stopped',
          patch: { error: null },
        };
      } else {
        outcome = {
          status: 'failed',
          patch: { error: error?.message || '下载失败' },
        };
      }
    }

    await finalizeDownloadTask(task, outcome.status, outcome.patch);
  })();
  runtime.completion = completion;
  return completion;
}

// 执行实际下载
async function executeDownload(task) {
  const { id, url, filename, savePath, videoInfo, type, platform } = task;

  try {
    console.log('[Download] 开始下载:', url);
    console.log('[Download] 文件名:', filename);
    console.log('[Download] 保存路径:', savePath);

    if (task.cancelled) {
      const requestedTerminal = taskCancellationStatuses.get(task);
      await finalizeDownloadTask(task, requestedTerminal === 'deleted' ? 'deleted' : 'stopped', {
        error: null,
      });
      return;
    }
    if (task.status === 'pending' && !transitionTask(task, 'downloading', { error: null })) return;
    if (task.status !== 'downloading') return;

    // 通知渲染进程任务已开始
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-progress', {
        id,
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
      });
    }

    // Handle comment download differently
    if (type === 'comment') {
      await executeCommentDownload(task);
      return;
    }

    // Handle album download differently（图集：一个文件夹内多张图片）
    if (type === 'album') {
      await executeAlbumDownload(task);
      return;
    }

    // Handle B站 DASH download differently（视频流+音频流分离，下载后用 ffmpeg 合并）
    if (type === 'dash') {
      await executeDashDownload(task);
      return;
    }

    // Handle m3u8 (HLS) download differently（下载所有 ts 分片后用 ffmpeg 合并）
    if (type === 'm3u8') {
      await executeM3u8Download(task);
      return;
    }

    // Handle mpd (DASH 清单) download differently（解析清单，下载音视频分片后 ffmpeg 合并）
    if (type === 'mpd') {
      await executeMpdDownload(task);
      return;
    }

    if (type === 'live') {
      await executeLiveRecording(task);
      return;
    }

    // Handle yt-dlp download differently（yt-dlp 站点流地址多需签名，由 yt-dlp 下载并合并）
    if (type === 'ytdl') {
      await executeYtdlDownload(task);
      return;
    }


    // Handle 红果短剧 download
    if (type === 'hongguo') {
      await executeHongguoDownload(task);
      return;
    }

    // 任务创建后若目标位置又出现同名文件，保留现有文件并重新预留一个安全文件名。
    if (fs.existsSync(task.savePath)) {
      releaseDownloadPath(task.savePath);
      task.savePath = reserveDownloadPath(task.savePath);
      task.filename = path.basename(task.savePath);
      saveDownloadTasks();
    }

    await executeDirectDownload(task);
    return;

  } catch (error) {
    console.error('[Download] 下载失败:', error && (error.code || error.message));
    if (TERMINAL.has(task.status)) throw error;

    const requestedTerminal = taskCancellationStatuses.get(task);
    const wasAborted = task.cancelled
      || error?.code === 'DOWNLOAD_ABORTED'
      || error?.code === 'ERR_CANCELED'
      || axios.isCancel(error);
    if (wasAborted) {
      await finalizeDownloadTask(task, requestedTerminal === 'deleted' ? 'deleted' : 'stopped', {
        error: null,
      });
      return;
    }
    await finalizeDownloadTask(task, 'failed', {
      error: error?.message || '下载失败',
    });
  }
}

// 计算并创建指定的自定义子文件夹路径（例如：张三--主页）
function resolveCustomDir(customDir, fallbackVideoInfo = null) {
  if (!customDir || !String(customDir).trim()) {
    return getDownloadDir(fallbackVideoInfo);
  }
  const settings = db.getKV('settings', {}) || {};
  const fallback = app.getPath('downloads');
  let root = settings.root && String(settings.root).trim()
    ? String(settings.root).trim()
    : fallback;

  if (settings.folder_name && String(settings.folder_name).trim()) {
    const sub = sanitizeFolderName(settings.folder_name);
    if (sub) root = path.join(root, sub);
  }

  const folderName = sanitizeFolderName(customDir);
  const targetDir = path.isAbsolute(customDir) ? customDir : path.join(root, folderName);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    return targetDir;
  } catch (err) {
    console.error('[Download] 无法创建自定义下载目录:', err.message);
    return getDownloadDir(fallbackVideoInfo);
  }
}

function resolveRendererDownloadDir(event, customDir, fallbackVideoInfo = null) {
  if (!customDir || !String(customDir).trim()) {
    return getDownloadDir(fallbackVideoInfo);
  }

  const requested = String(customDir).trim();
  if (path.isAbsolute(requested)) {
    if (!event || !event.sender) {
      const error = new Error('下载目录未经文件夹选择器授权');
      error.code = 'INVALID_DOWNLOAD_PATH';
      throw error;
    }
    const approved = downloadDirectoryTokens.resolve(event.sender.id, requested);
    if (!approved) {
      const error = new Error('下载目录未经文件夹选择器授权');
      error.code = 'INVALID_DOWNLOAD_PATH';
      throw error;
    }
    fs.mkdirSync(approved, { recursive: true });
    return approved;
  }

  if (requested === '.' || requested === '..' || /[\\/]/.test(requested)) {
    const error = new Error('下载子目录包含不安全的路径片段');
    error.code = 'INVALID_DOWNLOAD_PATH';
    throw error;
  }
  return resolveCustomDir(requested, fallbackVideoInfo);
}

// 下载文件
ipcMain.handle('download-file', async (event, { url, filename, videoInfo, platform, customDir, batchId, batchInfo, headers }) => {
  try {
    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    // 「文件命名格式」仅作用于抖音视频；多平台解析器（TikTok/B站等 18+ 平台）、直播等其他平台
    // 保持前端原有的「标题_平台」命名
    const isDouyin = platform === 'douyin' || (videoInfo && videoInfo.platform === 'douyin');
    const formattedFilename = isDouyin
      ? applyNameFormat(getCurrentSettings().name_format, videoInfo, filename)
      : filename;
    const finalFilename = sanitizeWindowsFilename(formattedFilename, 'video.mp4');
    const resolvedDir = resolveRendererDownloadDir(event, customDir, videoInfo);
    const savePath = reserveDownloadPath(resolveInsideRoot(resolvedDir, finalFilename));

    // 创建下载任务
    const task = {
      id: taskId,
      filename: path.basename(savePath),
      url,
      savePath,
      videoInfo,
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      headers: headers || null,   // 自定义请求头（通用下载器传 Referer/UA 防防盗链）
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
    };

    downloadTasks.push(task);
    enqueueDownload(task);

    // 保存到持久化存储
    saveDownloadTasks();

    // 通知前端新任务（过滤掉不可序列化的对象）
    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }

    return { success: true, taskId };
  } catch (error) {
    if (error && error.code === 'INVALID_DOWNLOAD_PATH') {
      return {
        success: false,
        code: 'INVALID_DOWNLOAD_PATH',
        error: '下载路径无效，请重新选择保存目录',
      };
    }
    console.error('[Download] 创建下载任务失败:', error.message);
    return { success: false, error: error.message || '创建下载任务失败' };
  }
});

// RTMP/RTMPS 直播录制。保持独立 IPC，旧的 HTTP-FLV download-file 调用不受影响。
ipcMain.handle('record-live-stream', async (event, { streamUrl, filename, videoInfo, platform, customDir, batchId, batchInfo, headers }) => {
  try {
    if (!ffmpegPath) return { success: false, error: 'ffmpeg 未安装，无法录制直播' };
    let parsed;
    try {
      parsed = new URL(String(streamUrl || ''));
    } catch (_) {
      return { success: false, error: '直播流地址无效' };
    }
    if (!['rtmp:', 'rtmps:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { success: false, error: '仅支持无内嵌凭据的 RTMP/RTMPS 直播流' };
    }

    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    let finalFilename = sanitizeWindowsFilename(filename, 'live.flv');
    if (!['.flv', '.mp4'].includes(path.extname(finalFilename).toLowerCase())) {
      finalFilename = `${path.basename(finalFilename, path.extname(finalFilename))}.flv`;
    }
    const resolvedDir = resolveRendererDownloadDir(event, customDir, videoInfo);
    const savePath = reserveDownloadPath(resolveInsideRoot(resolvedDir, finalFilename));
    const task = {
      id: taskId,
      filename: path.basename(savePath),
      url: parsed.toString(),
      savePath,
      videoInfo,
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      headers: headers || null,
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      type: 'live',
    };

    downloadTasks.push(task);
    enqueueDownload(task);
    saveDownloadTasks();
    if (mainWindow && mainWindow.webContents) {
      const { runtime, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }
    return { success: true, taskId };
  } catch (error) {
    if (error && error.code === 'INVALID_DOWNLOAD_PATH') {
      return { success: false, code: 'INVALID_DOWNLOAD_PATH', error: '下载路径无效，请重新选择保存目录' };
    }
    console.error('[Live] 创建录制任务失败:', error.message);
    return { success: false, error: error.message || '创建直播录制任务失败' };
  }
});

// 多平台视频链接解析
ipcMain.handle('parse-video-link', async (event, text) => {
  try {
    if (!text || typeof text !== 'string') {
      return { success: false, error: '请输入链接' };
    }
    const result = await multiParser.parse(text);
    return result;
  } catch (error) {
    console.error('[MultiParse] 解析失败:', error);
    return { success: false, error: error.message || '解析失败' };
  }
});

// 多平台图集下载（一个任务对应一个文件夹，内部依次下载所有图片/视频）
ipcMain.handle('download-album', async (event, { items, videoInfo, platform, customDir, batchId, batchInfo }) => {
  try {
    if (!items || !Array.isArray(items) || items.length === 0) {
      return { success: false, error: '没有可下载的内容' };
    }

    const baseTitle = (videoInfo?.title || '图集').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 40);
    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const resolvedDir = customDir ? resolveCustomDir(customDir, videoInfo) : undefined;

    // 图集任务：单个任务，对应一个文件夹
    const task = {
      id: taskId,
      filename: `${baseTitle}（${items.length}张）`,
      url: 'album-data',  // 标记为图集任务
      savePath: '',        // 文件夹路径，在 executeAlbumDownload 中设置
      videoInfo: { ...videoInfo, platform },
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: items.length,  // 图集的总进度按图片张数算
      startTime: Date.now(),
      type: 'album',              // 标记任务类型为图集
      albumItems: items,          // 图集的所有下载项
      albumIndex: 0,              // 当前下载到第几张
      albumDir: '',               // 图集文件夹路径
    };

    downloadTasks.push(task);
    enqueueDownload(task);

    saveDownloadTasks();

    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }

    return { success: true, taskIds: [taskId] };
  } catch (error) {
    console.error('[MultiDownload] 图集下载失败:', error);
    return { success: false, error: error.message || '下载失败' };
  }
});

// B站 DASH 下载（视频流+音频流分离，单个任务，下载后用 ffmpeg 合并成 mp4）
ipcMain.handle('download-dash', async (event, { videoUrl, audioUrl, videoInfo, platform, customDir, batchId, batchInfo, headers }) => {
  try {
    if (!videoUrl || !audioUrl) {
      return { success: false, error: '缺少视频流或音频流地址' };
    }
    if (!ffmpegPath) {
      return { success: false, error: 'ffmpeg 未安装，无法合并 DASH 流' };
    }

    const baseTitle = (videoInfo?.title || 'B站视频').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 50);
    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const resolvedDir = customDir ? resolveCustomDir(customDir, videoInfo) : undefined;

    // DASH 任务：单个任务，内部下载视频流+音频流后用 ffmpeg 合并
    const task = {
      id: taskId,
      filename: `${baseTitle}.mp4`,
      url: 'dash-data',  // 标记为 DASH 任务
      savePath: '',      // 最终 mp4 路径，在 executeDashDownload 中设置
      videoInfo: { ...videoInfo, platform },
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      headers: headers || null,   // 自定义请求头（通用下载器传 Referer/UA 防防盗链）
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      type: 'dash',          // 标记任务类型为 DASH
      dashVideoUrl: videoUrl,
      dashAudioUrl: audioUrl,
    };

    downloadTasks.push(task);
    enqueueDownload(task);

    saveDownloadTasks();

    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }

    return { success: true, taskIds: [taskId] };
  } catch (error) {
    console.error('[MultiDownload] DASH 下载失败:', error);
    return { success: false, error: error.message || '下载失败' };
  }
});

// m3u8 (HLS) 下载（A站等流媒体：下载所有 ts 分片后用 ffmpeg 合并成 mp4，单个任务）
ipcMain.handle('download-m3u8', async (event, { m3u8Url, videoInfo, platform, customDir, batchId, batchInfo, headers }) => {
  try {
    if (!m3u8Url) {
      return { success: false, error: '缺少 m3u8 地址' };
    }
    if (!ffmpegPath) {
      return { success: false, error: 'ffmpeg 未安装，无法合并 HLS 分片' };
    }

    const baseTitle = (videoInfo?.title || '视频').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 50);
    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const resolvedDir = customDir ? resolveCustomDir(customDir, videoInfo) : undefined;

    // m3u8 任务：单个任务，内部下载所有 ts 分片后用 ffmpeg 合并
    const task = {
      id: taskId,
      filename: `${baseTitle}.mp4`,
      url: 'm3u8-data',  // 标记为 m3u8 任务
      savePath: '',      // 最终 mp4 路径，在 executeM3u8Download 中设置
      videoInfo: { ...videoInfo, platform },
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      headers: headers || null,   // 自定义请求头（通用下载器传 Referer/UA 防防盗链）
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      type: 'm3u8',          // 标记任务类型为 m3u8 (HLS)
      m3u8Url: m3u8Url,
    };

    downloadTasks.push(task);
    enqueueDownload(task);

    saveDownloadTasks();

    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }

    return { success: true, taskIds: [taskId] };
  } catch (error) {
    console.error('[MultiDownload] m3u8 下载失败:', error);
    return { success: false, error: error.message || '下载失败' };
  }
});

// mpd (DASH 清单) 下载（猫抓方案：解析清单，下载音视频分片后 ffmpeg 合并成 mp4，单个任务）
ipcMain.handle('download-mpd', async (event, { mpdUrl, videoInfo, platform, customDir, batchId, batchInfo, headers }) => {
  try {
    if (!mpdUrl) {
      return { success: false, error: '缺少 mpd 清单地址' };
    }
    if (!ffmpegPath) {
      return { success: false, error: 'ffmpeg 未安装，无法合并 DASH 分片' };
    }

    const baseTitle = (videoInfo?.title || '视频').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 50);
    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const resolvedDir = customDir ? resolveCustomDir(customDir, videoInfo) : undefined;

    const task = {
      id: taskId,
      filename: `${baseTitle}.mp4`,
      url: 'mpd-data',   // 标记为 mpd 任务
      savePath: '',      // 最终 mp4 路径，在 executeMpdDownload 中设置
      videoInfo: { ...videoInfo, platform },
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      headers: headers || null,   // 自定义请求头（通用下载器传 Referer/UA 防防盗链）
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      type: 'mpd',          // 标记任务类型为 mpd (DASH 清单)
      mpdUrl: mpdUrl,
    };

    downloadTasks.push(task);
    enqueueDownload(task);

    saveDownloadTasks();

    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }

    return { success: true, taskIds: [taskId] };
  } catch (error) {
    console.error('[MultiDownload] mpd 下载失败:', error);
    return { success: false, error: error.message || '下载失败' };
  }
});

// yt-dlp 下载：yt-dlp 站点（YouTube/Instagram/Twitter 等）视频流多需签名，由 yt-dlp 解析下载并用 ffmpeg 合并为单个 mp4
// 单个任务，内部 spawn yt-dlp 处理下载+合并
ipcMain.handle('download-ytdl', async (event, { url, videoInfo, platform, formatId, customDir, batchId, batchInfo }) => {
  try {
    if (!url) {
      return { success: false, error: '缺少视频地址' };
    }
    if (!ytDlpPath) {
      return { success: false, error: '未找到 yt-dlp，无法下载视频' };
    }
    if (!ffmpegPath) {
      return { success: false, error: 'ffmpeg 未安装，无法合并视频' };
    }

    const baseTitle = (videoInfo?.title || '视频').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 80);
    const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

    // yt-dlp 任务：单个任务，内部 spawn yt-dlp 下载视频流+音频流并合并
    // customDir/batchId/batchInfo 与 download-file 一致：支持主页下载的
    // 「按用户建文件夹 + 下载管理批次分组」模式（YouTube 主页下载同抖音）
    const resolvedDir = customDir ? resolveCustomDir(customDir, videoInfo) : undefined;
    const task = {
      id: taskId,
      filename: `${baseTitle}.mp4`,
      url: 'ytdl-data',       // 标记为 yt-dlp 任务
      savePath: '',           // 最终 mp4 路径，在 executeYtdlDownload 中设置
      videoInfo: { ...videoInfo, platform },
      platform: platform || videoInfo?.platform || '',
      customDir: resolvedDir,
      batchId,
      batchInfo,
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      type: 'ytdl',           // 标记任务类型为 yt-dlp 下载
      ytdlUrl: url,           // 解析后确定的下载入口 URL（YouTube watch / Instagram / Twitter ...）
      ytdlMaxHeight: formatId ? Number(formatId) : 0, // 用户选择的最大清晰度高度（0=不限/最高）；前端把 height 当 formatId 传
    };

    downloadTasks.push(task);
    enqueueDownload(task);

    saveDownloadTasks();

    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-task-added', serializableTask);
    }

    return { success: true, taskIds: [taskId] };
  } catch (error) {
    console.error('[MultiDownload] yt-dlp 下载失败:', error);
    return { success: false, error: error.message || '下载失败' };
  }
});

// 下载评论数据
ipcMain.handle('download-comments', async (event, { awemeId, videoTitle }) => {
  const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
  const filename = `评论_${videoTitle || awemeId}_${timestamp}.csv`;
  const sanitizedFilename = filename.replace(/[<>:"/\\|?*\n\r]/g, '_');
  const savePath = path.join(getDownloadDir(), sanitizedFilename);

  // 创建下载任务
  const task = {
    id: taskId,
    filename: sanitizedFilename,
    url: 'comment-data', // 标记为评论数据任务
    savePath,
    videoInfo: { awemeId, videoTitle },
    status: 'pending',
    progress: 0,
    receivedBytes: 0,
    totalBytes: 0,
    startTime: Date.now(),
    type: 'comment', // 标记任务类型
  };

  downloadTasks.push(task);
  enqueueDownload(task);

  // 保存到持久化存储
  saveDownloadTasks();

  // 通知前端新任务
  if (mainWindow && mainWindow.webContents) {
    const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
    mainWindow.webContents.send('download-task-added', serializableTask);
  }

  return { success: true, taskId };
});

// 打开文件所在文件夹
ipcMain.handle('open-folder', async (event, taskId) => {
  if (taskId && typeof taskId === 'object' && taskId.scope === 'download-root') {
    const downloadDir = getDownloadDir();
    const openError = await shell.openPath(downloadDir);
    return openError ? { success: false, error: openError } : { success: true };
  }
  const task = downloadTasks.find(t => t.id === taskId);
  if (!task) {
    return { success: false, error: '任务不存在' };
  }

  // 1) 优先尝试打开任务指定的 customDir 目录（如：张三--主页 专属文件夹）
  if (task.customDir && fs.existsSync(task.customDir)) {
    await shell.openPath(task.customDir);
    return { success: true };
  }

  // 2) 如果 savePath 存在
  if (task.savePath && fs.existsSync(task.savePath)) {
    const isDir = fs.statSync(task.savePath).isDirectory();
    if (isDir) {
      await shell.openPath(task.savePath);
      return { success: true };
    }
    // 文件存在：在资源管理器中选中定位该文件
    shell.showItemInFolder(task.savePath);
    return { success: true };
  }

  // 3) 如果文件尚未生成完成（下载中/等待中），退而求其次打开其所在的父目录
  if (task.savePath) {
    const parentDir = path.dirname(task.savePath);
    if (fs.existsSync(parentDir)) {
      await shell.openPath(parentDir);
      return { success: true };
    }
  }

  return { success: false, error: '文件夹不存在' };
});

// 获取下载任务列表
ipcMain.handle('get-download-tasks', () => {
  // 按 startTime 降序：最新下载排在最前面
  // （内存数组是 push 到末尾的，需在此排序保证前端展示顺序）
  const sorted = downloadTasks.slice().sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  // 返回时过滤掉不可序列化的对象
  return sorted.map(task => {
    const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
    return serializableTask;
  });
});

// 删除下载任务
ipcMain.handle('delete-task', async (event, taskId) => {
  try {
    const deleted = await deleteDownloadTaskById(taskId);
    if (!deleted) return { success: false, error: '任务不存在' };
    return { success: true };
  } catch (error) {
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    return { success: false, error: error?.message || '删除任务失败' };
  }
});

// 批量删除下载任务（一次传入多个 ID，统一处理 + 只落盘一次，避免逐个删除慢）
ipcMain.handle('delete-tasks', async (event, taskIds) => {
  const ids = [...new Set(Array.isArray(taskIds) ? taskIds : [])];
  let deleted = 0;
  const failures = [];
  for (const taskId of ids) {
    try {
      if (await deleteDownloadTaskById(taskId)) deleted += 1;
    } catch (error) {
      failures.push({ id: taskId, code: error?.code || 'DELETE_FAILED' });
    }
  }
  return {
    success: failures.length === 0,
    deleted,
    ...(failures.length > 0 ? { partial: deleted > 0, failures } : {}),
  };
});

// 停止下载任务
ipcMain.handle('stop-download', async (event, taskId) => {
  const task = downloadTasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  try {
    const removedFromScheduler = downloadScheduler.remove(taskId);
    if (removedFromScheduler) {
      await finalizeDownloadTask(task, 'stopped', { error: null });
      return { success: true };
    }

    if (task.status !== 'pending' && task.status !== 'downloading') {
      return { success: false, error: '任务已经结束' };
    }
    requestTaskCancellation(task, 'stopped');
    await waitForTaskExecution(taskId);
    if (task.status === 'pending' || task.status === 'downloading') {
      await finalizeDownloadTask(task, 'stopped', { error: null });
    }
    return { success: true };
  } catch (error) {
    const persistenceFailure = persistenceFailureResult(error);
    if (persistenceFailure) return persistenceFailure;
    return { success: false, error: error?.message || '停止任务失败' };
  }
});

// 判断是否为小红书主页下载的占位任务（url 还是 'xhs-note'，需重新解析才能下载）
function isXhsPlaceholderTask(task) {
  return !!(task && (task.type === 'xhs-note' || task.url === 'xhs-note'));
}

// ===== 小红书主页下载：yt-dlp 优先 + feed 回退 =====
//
// 下载顺序（首次与重试一致）：
//   1. 把笔记链接（explore/<noteId>?xsec_token=...）直接交给 yt-dlp 解析下载（带登录 cookie）；
//   2. yt-dlp 失败（图集笔记 / 解析器失效 / 风控）→ 自动回退隐藏窗口 feed 解析拿直链下载。

// 拼笔记页 URL（yt-dlp 解析入口；xsec_token 缺失时页面可能被风控，失败会回退 feed）
function buildXhsExploreUrl(noteId, xsecToken) {
  const base = `https://www.xiaohongshu.com/explore/${noteId}`;
  return xsecToken
    ? `${base}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_user`
    : base;
}

// 从任务恢复笔记标识：xhsNote（进程内）优先，其次 videoInfo（落 DB，重启后仍在）
function getXhsNoteRef(task) {
  if (!task) return null;
  const videoInfo = task.videoInfo && typeof task.videoInfo === 'object' ? task.videoInfo : {};
  let noteId = (task.xhsNote && task.xhsNote.noteId) || '';
  if (!noteId && typeof videoInfo.sourceUrl === 'string') {
    const m = videoInfo.sourceUrl.match(/\/explore\/([a-f0-9]+)/i);
    if (m) noteId = m[1];
  }
  if (!noteId) return null;
  const xsecToken = (task.xhsNote && task.xhsNote.xsecToken)
    || (typeof videoInfo.xsecToken === 'string' ? videoInfo.xsecToken : '')
    || '';
  return { noteId, xsecToken };
}

// yt-dlp 失败后是否可回退 feed 解析（仅小红书 ytdl 任务，且本轮未回退过，防止循环）
function canFallbackToXhsFeed(task) {
  if (!task || task.platform !== 'xiaohongshu' || task.type !== 'ytdl') return false;
  if (task.xhsFeedFallbackUsed) return false;
  return !!getXhsNoteRef(task);
}

// yt-dlp 失败 → 任务转回「解析中」，后台用 feed 接口（登录态）重新解析并入队下载。
// 调用方（executeYtdlDownload）此时仍占着调度器执行槽，解析入队在异步侧等槽释放后进行。
function startXhsFeedFallback(task) {
  task.xhsFeedFallbackUsed = true; // 本轮下载只回退一次；重试时清除
  const ref = getXhsNoteRef(task);
  task.xhsNote = { noteId: ref.noteId, xsecToken: ref.xsecToken };
  task.status = 'parsing';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.error = null;
  saveDownloadTasks();
  if (mainWindow && mainWindow.webContents) {
    const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
    mainWindow.webContents.send('download-progress', serializableTask);
  }

  (async () => {
    // 等调度器释放本任务的执行槽（executeYtdlDownload 返回后 active 才清除），
    // 否则 feed 解析成功后的重新入队会因「任务已存在」被拒绝。
    for (let i = 0; i < 100 && downloadScheduler.has(task.id); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    // 回退期间任务被用户停止/删除：不再解析
    if (task.cancelled || TERMINAL.has(task.status) || !downloadTasks.includes(task)) return;
    const r = await resolveXhsTask(task);
    if (task.cancelled || !downloadTasks.includes(task)) return;
    if (r && r.ok) enqueueXhsTask(task);
    // r.ok=false 时 resolveXhsTask 已把任务标记为 failed 并通知前端
  })().catch(e => {
    console.error('[XhsProfile] feed 回退解析异常:', e.message);
    task.status = 'failed';
    task.error = '回退解析失败: ' + e.message;
    task.endTime = Date.now();
    saveDownloadTasks();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
    }
  });
}

// 重试是否应重写为 yt-dlp 优先任务：
//   - 仅限小红书主页批量下载的任务（batchId 'xhsbatch_' 前缀 / 占位任务 / 已是 ytdl 任务）；
//   - 已解析出的图集任务（type='album'）yt-dlp 无法下载，仍走原重试路径（直接重下图片地址）。
function shouldRetryXhsViaYtdl(task) {
  if (!task || task.platform !== 'xiaohongshu') return false;
  if (task.type === 'album') return false;
  const fromProfile = (typeof task.batchId === 'string' && task.batchId.indexOf('xhsbatch_') === 0)
    || !!task.xhsNote
    || task.type === 'ytdl'
    || isXhsPlaceholderTask(task);
  if (!fromProfile) return false;
  return !!getXhsNoteRef(task);
}

// 把小红书主页任务重写为 yt-dlp 优先形态（只改任务载荷，不改状态；状态由重试路径的
// resetAndEnqueueTaskForRetry 合法重置）。重写后按普通任务重试，失败再自动回退 feed。
function rewriteXhsTaskToYtdlFirst(task) {
  const ref = getXhsNoteRef(task);
  if (!ref) return false;
  task.type = 'ytdl';
  task.url = 'ytdl-data';
  task.ytdlUrl = buildXhsExploreUrl(ref.noteId, ref.xsecToken);
  task.ytdlMaxHeight = 0;
  task.xhsNote = { noteId: ref.noteId, xsecToken: ref.xsecToken };
  if (task.videoInfo && typeof task.videoInfo === 'object') {
    task.videoInfo.xsecToken = ref.xsecToken;
  }
  delete task.xhsFeedFallbackUsed;
  delete task.albumItems;
  delete task.failedAlbumItems;
  delete task.albumFolderName;
  delete task.albumIndex;
  delete task.albumDir;
  // 保存目录：沿用已有 savePath 的所在目录；占位任务（无 savePath）按主页规则重建
  if (task.savePath) {
    task.customDir = path.dirname(task.savePath);
  } else {
    const noteFolder = safeXhsName((task.videoInfo && task.videoInfo.title) || ref.noteId);
    task.customDir = path.join(getXhsCustomDir(task.videoInfo || {}), noteFolder);
    task.savePath = path.join(task.customDir, noteFolder + '.mp4');
    task.filename = noteFolder + '.mp4';
  }
  return true;
}

function validateTaskForRetry(task) {
  const validation = validateTaskPayload(buildTaskPayload(task));
  if (validation.valid) return { valid: true };

  // Legacy XHS rows did not persist album/media payloads. Recover only when the
  // original note URL and token are both present and the note id is unambiguous.
  const videoInfo = task && task.videoInfo && typeof task.videoInfo === 'object'
    ? task.videoInfo
    : {};
  const sourceUrl = typeof videoInfo.sourceUrl === 'string' ? videoInfo.sourceUrl : '';
  const xsecToken = typeof videoInfo.xsecToken === 'string' ? videoInfo.xsecToken : '';
  const noteMatch = sourceUrl.match(
    /^https?:\/\/(?:www\.)?xiaohongshu\.com\/explore\/([a-f0-9]+)(?:[/?#]|$)/i,
  );
  if (noteMatch && xsecToken.length > 0) {
    task.type = 'xhs-note';
    task.url = 'xhs-note';
    task.xhsNote = { noteId: noteMatch[1], xsecToken };
    return { valid: true, recoveredLegacyXhs: true };
  }

  const response = {
    success: false,
    code: 'TASK_PAYLOAD_INVALID',
    error: '任务下载信息不完整，无法重试，请重新添加该任务',
    requiresReAdd: true,
  };
  if (sourceUrl) response.sourceUrl = sourceUrl;
  return { valid: false, response };
}

/**
 * 重新解析小红书占位任务（第一步：解析+改写，不入队不下载）。
 * 调 feed 接口拿真实下载地址，改写 task 为真实下载任务（status=pending）。
 * 供单个重试与批量重试共用；批量场景下先全部解析完，再统一入队启动下载
 * （否则每个任务解析完立即下载，表现为"一个一个"进下载中）。
 * 返回 { ok: true } 或 { ok: false, error, loginFailure }
 */
async function resolveXhsTask(task) {
  const taskId = task.id;
  // 优先用 xhsNote 字段；若已被删除（解析成功后删除），从 videoInfo.sourceUrl 提取 noteId
  let noteId = task.xhsNote && task.xhsNote.noteId;
  // token 读取优先级：xhsNote（进程内） -> videoInfo.xsecToken（DB 持久化）
  let xsecToken = (task.xhsNote && task.xhsNote.xsecToken) || (task.videoInfo && task.videoInfo.xsecToken) || '';
  if (!noteId && task.videoInfo && task.videoInfo.sourceUrl) {
    const m = task.videoInfo.sourceUrl.match(/\/explore\/([a-f0-9]+)/);
    if (m) noteId = m[1];
  }
  if (!noteId) {
    // 没有 xhsNote 字段（已被删除），无法重新解析
    task.status = 'failed';
    task.error = '无法重新解析（笔记信息已丢失），请重新从主页下载';
    task.endTime = Date.now();
    saveDownloadTasks();
    return { ok: false, error: task.error };
  }

  // xsec_token 缺失（老任务持久化时未存）：feed 接口不带 token 会返回 300031。
  // 用 batchInfo.profileUrl（主页 URL 带主页 token）重新抓一次作品列表，按 noteId
  // 匹配该笔记自己的 xsec_token。注意：fetchUserNotes 本身需要登录态，若它报
  // 「未登录/登录失效」，说明 cookie 真失效了（见下方 loginFailure 处理）。
  if (!xsecToken && task.batchInfo && task.batchInfo.profileUrl) {
    try {
      console.log('[RetryTask] 缺少 xsec_token，重新抓取主页列表恢复...');
      const xhsProfile = require('./src/native/xhsProfile');
      const listResult = await xhsProfile.fetchUserNotes(task.batchInfo.profileUrl, null, 10);
      const matched = (listResult && listResult.notes || []).find(n => String(n.noteId) === String(noteId));
      if (matched && matched.xsecToken) {
        xsecToken = matched.xsecToken;
        console.log('[RetryTask] 已恢复 xsec_token（笔记列表匹配成功）');
      } else {
        console.warn('[RetryTask] 主页列表中未找到该笔记，可能已被删除或不在前', 10, '页');
      }
    } catch (e) {
      const em = String(e && e.message || '');
      console.warn('[RetryTask] 重新抓取列表失败:', em.slice(0, 120));
      // 抓列表报「未登录/登录失效」= cookie 真失效（区别于单纯缺 token 的 300031）。
      // 只认确定性信号（fetchUserNotes 预检/改写的明确错误），
      // 不认「可能登录态失效」这类猜测文案（含"可能"二字，是多种原因之一）。
      if (/小红书登录态失效：|小红书未登录（/.test(em)) {
        task.status = 'failed';
        task.error = '小红书登录态失效：' + em + '。请重新登录小红书后再试。';
        task.endTime = Date.now();
        saveDownloadTasks();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
        }
        return { ok: false, error: task.error, loginFailure: true };
      }
    }
  }

  console.log('[RetryTask] 小红书任务需重新解析:', noteId);
  task.status = 'parsing';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.cancelled = false;
  task.skipped = false;
  delete task.error;
  delete task.cancelSource;
  delete task.writer;
  delete task.ytdlProcess;
  // 确保 xhsNote 存在（供下次失败重试用）；xsecToken 同时写进 videoInfo 持久化
  // （xhsNote 字段不落 DB，重启后丢失；videoInfo.xsecToken 会随 download_tasks 落盘）
  task.xhsNote = { noteId, xsecToken };
  if (!task.videoInfo) task.videoInfo = {};
  task.videoInfo.xsecToken = xsecToken;
  saveDownloadTasks();
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('download-progress', { ...task });
  }

  // 重新解析（feed 接口 + note_card），成功后改写为真实下载任务（status=pending，不入队）
  try {
    const xhsProfile = require('./src/native/xhsProfile');
    const r = await xhsProfile.fetchNoteDetail({ noteId, xsecToken });
    const { parseNoteCard } = require('./src/native/multi-parser/parsers/xiaohongshu');
    const data = parseNoteCard(r);
    if (data.type === 'video' && data.video && data.video.url) {
      const noteFolder = safeXhsName(data.title);
      const workDir = path.join(getXhsCustomDir(task.videoInfo), noteFolder);
      task.url = data.video.url;
      task.filename = noteFolder + '.mp4';
      task.savePath = path.join(workDir, noteFolder + '.mp4');
      task.status = 'pending';
      task.type = '';
      task.videoInfo = { ...task.videoInfo, title: data.title, cover: data.cover, author: (data.author && data.author.name) || task.videoInfo.author };
      delete task.xhsNote;
      fs.mkdirSync(workDir, { recursive: true });
    } else if (data.type === 'album' && data.album && data.album.length > 0) {
      const noteFolder = safeXhsName(data.title);
      task.albumItems = data.album.map(img => img.url);
      task.filename = noteFolder + '（' + data.album.length + '张）';
      task.customDir = getXhsCustomDir(task.videoInfo);
      task.albumFolderName = noteFolder;
      task.savePath = '';
      task.totalBytes = data.album.length;
      task.albumIndex = 0;
      task.albumDir = '';
      task.status = 'pending';
      task.type = 'album';
      task.videoInfo = { ...task.videoInfo, title: data.title, cover: data.cover, author: (data.author && data.author.name) || task.videoInfo.author };
      delete task.xhsNote;
    } else {
      task.status = 'failed';
      task.error = '无法解析下载地址（可能笔记已被删除或为非视频/图集类型）';
      task.endTime = Date.now();
      saveDownloadTasks();
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
      }
      return { ok: false, error: task.error };
    }

    saveDownloadTasks();
    return { ok: true };
  } catch (e) {
    task.status = 'failed';
    // 区分登录失效 vs 真解析失败，让用户知道下一步该做什么：
    //   - 登录失效：提示"请重新登录小红书"（fetchNoteDetail 已把错误改写为明确文案）
    //   - 真解析失败：保留原始错误（笔记删除/网络问题/风控等）
    const isLoginFailure = /小红书登录态失效：|小红书未登录（/.test(e.message);
    task.error = isLoginFailure
      ? e.message + '（已停止后续任务的解析，请重新登录后再批量重试）'
      : '重新解析失败: ' + e.message;
    task.endTime = Date.now();
    saveDownloadTasks();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
    }
    // 登录态失效：fetchNoteDetail 已把错误改写为明确的「登录态失效…请重新登录」，
    // 这里打标返回，让批量重试循环识别后提前停止（后续任务都会同样失败，不必逐个等超时）。
    // 注意：只认「确定性」信号（我们改写的错误/预检错误），不认 fetchUserNotes 的
    // 「可能登录态失效」这类猜测性文案（那是多种可能之一，不一定是登录问题）。
    return { ok: false, error: task.error, loginFailure: isLoginFailure };
  }
}

/**
 * 入队并启动下载（第二步）。批量场景在全部解析完后对每个成功任务调用，
 * 由有界调度器一次填满可用下载槽位；单个重试场景解析完立即调用。
 */
function enqueueXhsTask(task) {
  const enqueued = enqueueDownload(task);
  if (!enqueued) {
    task.status = 'failed';
    task.error = '解析已完成，但任务入队失败，请稍后重试';
    task.endTime = Date.now();
    saveDownloadTasks();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
    }
    return false;
  }
  saveDownloadTasks();
  return true;
}

/**
 * 重新解析小红书占位任务并立即入队下载（单个重试用）。
 * 与批量重试共用 resolveXhsTask + enqueueXhsTask。
 * 返回 { success: boolean, error?: string, loginFailure?: boolean }
 */
async function reparseXhsTask(task) {
  const r = await resolveXhsTask(task);
  if (r && r.ok) {
    if (!enqueueXhsTask(task)) {
      return { success: false, error: '任务已在等待或下载中，无法重复入队' };
    }
    return { success: true };
  }
  return r
    ? { success: false, error: r.error, loginFailure: r.loginFailure }
    : { success: false, error: '重新解析失败' };
}

// 重试失败/部分完成/已停止的任务
ipcMain.handle('retry-task', async (event, taskId) => {
  const task = downloadTasks.find(t => t.id === taskId);
  if (!task) {
    return { success: false, error: '任务不存在' };
  }

  const retryableStatuses = ['failed', 'partial', 'stopped'];
  if (!retryableStatuses.includes(task.status)) {
    return { success: false, error: '仅失败、部分完成或已停止的任务可以重试' };
  }
  if (downloadScheduler.has(task.id)) {
    return { success: false, error: '任务仍在停止/执行中，请稍后重试' };
  }

  const payloadValidation = validateTaskForRetry(task);
  if (!payloadValidation.valid) return payloadValidation.response;

  // 小红书主页任务：重写为 yt-dlp 优先形态后按普通任务重试（与首次下载顺序一致：
  // 先 yt-dlp，失败自动回退 feed 解析）；已解析出的图集任务保持原路径直接重下图片。
  if (shouldRetryXhsViaYtdl(task)) rewriteXhsTaskToYtdlFirst(task);

  const isXhsRetry = isXhsPlaceholderTask(task);
  if (!isXhsRetry) {
    const retryPreparation = resetAndEnqueueTaskForRetry(
      task,
      candidate => enqueueDownload(candidate),
    );
    if (!retryPreparation.ok) {
      const error = retryPreparation.reason === 'enqueue'
        ? '任务入队失败，已恢复原状态，请稍后重试'
        : '任务状态重置失败，无法重试';
      return { success: false, error };
    }

    delete task.skipped;
    delete task.cancelSource;
    delete task.writer;
    delete task.ytdlProcess;
    delete task.tmpDir;

    // 普通任务已确认入队，随后才能清理半截文件。
    if (task.savePath && fs.existsSync(task.savePath)) {
      try {
        fs.unlinkSync(task.savePath);
        console.log('[RetryTask] 已清理上次失败留下的半截文件:', task.savePath);
      } catch (err) {
        console.warn('[RetryTask] 清理未完成文件失败:', err.message);
      }
    }

    saveDownloadTasks();

    if (mainWindow && mainWindow.webContents) {
      const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
      mainWindow.webContents.send('download-progress', serializableTask);
    }

    return { success: true };
  }

  // 小红书主页占位任务必须先合法重置，再重新解析真实下载地址。
  if (!resetTaskForRetry(task)) {
    return { success: false, error: '任务状态重置失败，无法重试' };
  }
  return await reparseXhsTask(task);
});

// 批量重试任务
ipcMain.handle('retry-tasks', async (event, taskIds) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return { success: false, error: '没有要重试的任务' };
  }

  let count = 0;
  const invalidPayloads = [];
  const xhsReparse = []; // 小红书占位任务（需重新解析才能下载）
  for (const taskId of taskIds) {
    const task = downloadTasks.find(t => t.id === taskId);
    if (!task) continue;

    const retryableStatuses = ['failed', 'partial', 'stopped'];
    if (!retryableStatuses.includes(task.status)) {
      console.warn('[RetryTasks] 跳过不可重试状态:', taskId, task.status);
      continue;
    }
    if (downloadScheduler.has(task.id)) {
      console.warn('[RetryTasks] 任务仍在停止/执行中，请稍后重试:', taskId);
      continue;
    }

    const payloadValidation = validateTaskForRetry(task);
    if (!payloadValidation.valid) {
      invalidPayloads.push({ taskId, ...payloadValidation.response });
      continue;
    }

    // 小红书主页任务重试与首次下载顺序一致：重写为 yt-dlp 优先形态后按普通任务
    // 重试（yt-dlp 失败自动回退 feed）；图集任务保持原路径直接重下图片。
    if (shouldRetryXhsViaYtdl(task)) rewriteXhsTaskToYtdlFirst(task);

    const isXhsRetry = isXhsPlaceholderTask(task);
    if (!isXhsRetry) {
      const retryPreparation = resetAndEnqueueTaskForRetry(
        task,
        candidate => enqueueDownload(candidate),
      );
      if (!retryPreparation.ok) {
        console.warn('[RetryTasks] 任务重置或入队失败，已保留原状态:', taskId, retryPreparation.reason);
        continue;
      }

      delete task.skipped;
      delete task.cancelSource;
      delete task.writer;
      delete task.ytdlProcess;
      delete task.tmpDir;

      // 普通任务已确认入队，随后才能清理半截文件。
      if (task.savePath && fs.existsSync(task.savePath)) {
        try {
          fs.unlinkSync(task.savePath);
          console.log('[RetryTasks] 已清理上次失败留下的半截文件:', task.savePath);
        } catch (err) {
          console.warn('[RetryTasks] 清理未完成文件失败:', err.message);
        }
      }

      if (mainWindow && mainWindow.webContents) {
        const { cancelSource, writer, ytdlProcess, ...serializableTask } = task;
        mainWindow.webContents.send('download-progress', serializableTask);
      }
      count++;
      continue;
    }

    // 小红书占位任务先完成合法 reset，再进入 parsing 并重新解析。
    if (!resetTaskForRetry(task)) {
      console.warn('[RetryTasks] 任务状态重置失败:', taskId);
      continue;
    }
    delete task.skipped;
    delete task.cancelSource;
    delete task.writer;
    delete task.ytdlProcess;
    delete task.tmpDir;
    xhsReparse.push(task);
  }

  if (count > 0) {
    saveDownloadTasks();
  }

  // 重新解析小红书占位任务（第一批：只解析+改写，不入队不下载）。
  // 串行 + 300ms 间隔（与批量解析一致，避免触发风控）。
  // 解析完成的任务暂存在 resolvedXhs 里，全部解析完后统一入队启动下载，
  // 让多个任务同时进入"下载中"（由有界调度器按并发数拉取），
  // 而不是每个解析完立即下载、一个一个进下载中。
  //
  // 改进：进入解析循环前，先把所有小红书占位任务一次性置为 parsing 并广播，
  // 这样用户点击"批量重试"后立即看到全部任务进入"解析中"，而不是随解析
  // 进度一条条地变（之前的体验像"卡住没反应"）。
  if (xhsReparse.length > 0) {
    for (const task of xhsReparse) {
      task.status = 'parsing';
      task.progress = 0;
      task.receivedBytes = 0;
      task.totalBytes = 0;
      task.cancelled = false;
      task.skipped = false;
      delete task.error;
      delete task.cancelSource;
      delete task.writer;
      delete task.ytdlProcess;
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-progress', { ...task });
      }
    }
    saveDownloadTasks();
    console.log(`[RetryTasks] 已将 ${xhsReparse.length} 个小红书任务置为"解析中"`);
  }

  // 解析前预检小红书登录态：cookie 彻底失效时直接提示，避免逐个任务等超时
  // （每个失败任务都要走完 ensureWindow + feed 重试 3 次 + 30s 冷却，体验很差）。
  // 预检只阻断"彻底没登录"的情况；token 失效（300031）仍由 resolveXhsTask 逐条处理。
  let xhsLoginPrechecked = true;
  if (xhsReparse.length > 0) {
    try {
      // 与 xhsProfile.checkLoginReady 一致的快速预检：
      // DB cookie 字符串里有 web_session，或分区会话里有 web_session，任一即算已登录
      const cs = db.getKV('cookie_xiaohongshu', '') || '';
      let hasSession = /(?:^|;\s*)web_session=[^;]+/.test(cs);
      if (!hasSession) {
        const ses = session.fromPartition('persist:xiaohongshu');
        const list = await ses.cookies.get({ name: 'web_session' }).catch(() => []);
        hasSession = !!(list && list.some(c => c && String(c.value || '').length > 0));
      }
      xhsLoginPrechecked = hasSession;
    } catch (e) {
      // 预检出错不阻断，继续走原解析流程（让 resolveXhsTask 自己报错）
      console.warn('[RetryTasks] 小红书登录态预检异常:', e.message);
    }
    if (!xhsLoginPrechecked) {
      const msg = '小红书登录态已失效（缺少 web_session 登录令牌）。请到「小红书主页提取」页面重新登录后再批量重试。';
      for (const task of xhsReparse) {
        task.status = 'failed';
        task.error = '小红书登录态失效：请重新登录小红书后再试。';
        task.endTime = Date.now();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
        }
      }
      saveDownloadTasks();
      const opts = {
        type: 'warning',
        title: '小红书登录态失效',
        message: msg,
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, opts);
      } else {
        dialog.showMessageBox(opts);
      }
      return { success: false, error: '小红书登录态失效', count, reparseCount: 0, loginStopped: true };
    }
  }

  let reparseCount = 0;
  let loginStopped = false; // 登录态失效后提前停止，避免剩余任务逐个等超时（都会同样失败）
  const resolvedXhs = []; // 解析成功、待统一入队的任务
  for (const task of xhsReparse) {
    try {
      const r = await resolveXhsTask(task);
      if (r && r.ok) {
        resolvedXhs.push(task);
        reparseCount++;
      } else if (r && r.loginFailure) {
        loginStopped = true;
        break;
      }
    } catch (e) {
      console.error('[RetryTasks] 小红书重新解析异常:', e.message);
    }
    // 每个任务间停顿，避免密集请求触发小红书风控（重定向 website-login/error）
    // 间隔从 800ms 降到 300ms：解析本身约 300ms/条，总速度提升约 2 倍。
    // 实测 300ms 串行在大批量下仍稳定（3 路并发才会触发风控）。
    await new Promise(r => setTimeout(r, 300));
  }
  // 第二批：统一入队并启动下载（一次填满 MAX_CONCURRENT_DOWNLOADS 个下载中）
  if (resolvedXhs.length > 0) {
    console.log(`[RetryTasks] 小红书解析完成，统一入队启动下载: ${resolvedXhs.length} 个`);
    for (const task of resolvedXhs) {
      enqueueXhsTask(task);
    }
  }
  if (xhsReparse.length > 0) {
    console.log(`[RetryTasks] 小红书占位任务重新解析完成: ${reparseCount}/${xhsReparse.length}${loginStopped ? '（登录态失效，提前停止）' : ''}`);
    // 登录态失效：弹窗提醒用户重新登录（单独重试失败时前端已 alert，批量场景这里补一个）
    if (loginStopped) {
      const opts = {
        type: 'warning',
        title: '小红书登录态失效',
        message: '小红书登录态已失效，后续任务需要重新登录才能解析。\n请到「小红书主页提取」页面重新登录后再试。',
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, opts);
      } else {
        dialog.showMessageBox(opts);
      }
    }
  }

  if (count === 0 && reparseCount === 0 && invalidPayloads.length > 0) {
    const firstFailure = invalidPayloads[0];
    return {
      success: false,
      code: 'TASK_PAYLOAD_INVALID',
      error: firstFailure.error,
      sourceUrl: firstFailure.sourceUrl,
      requiresReAdd: true,
      invalidTasks: invalidPayloads,
      count: 0,
      reparseCount: 0,
      loginStopped,
    };
  }
  return { success: true, count, reparseCount, loginStopped, invalidTasks: invalidPayloads };
});

// ===== 关注监控 (Monitor) =====
// 监控关注的用户（粉丝数变化、新视频发布）和关注的视频（数据变化）

let monitorUsers = [];
let monitorVideos = [];
let monitorEvents = [];
let monitorConfig = null;
let monitorTimer = null;
let monitorRunning = false;
// 启动后延迟首检的定时器（与周期 interval 分开管理，stopMonitor 时一并清理，
// 否则停止监控后 5 秒内仍可能跑一次 runMonitorCycle）
let monitorFirstCheckTimer = null;

// 从数据库载入监控状态（需在 db.initDatabase 完成后调用）
function loadMonitorStateFromDB() {
  monitorUsers = db.listMonitorUsers();
  monitorVideos = db.listMonitorVideos();
  monitorEvents = db.listMonitorEvents();
  monitorConfig = db.getMonitorConfig();
}

// 内存态列表与 DB 同步：以下函数在写入后调用 db 落盘
function saveMonitorUsers() { db.flushNow(); }
function saveMonitorVideos() { db.flushNow(); }
function saveMonitorEvents() { db.flushNow(); }
function saveMonitorConfig() { db.setMonitorConfig(monitorConfig); }

// 历史快照上限（超过则丢弃最早）
const MONITOR_HISTORY_LIMIT = 20000;

// 向用户记录追加粉丝历史快照点（按时间升序、截断上限）
function pushFollowerHistory(user, value) {
  if (typeof value !== 'number') return;
  if (!Array.isArray(user.followerHistory)) user.followerHistory = [];
  const now = Date.now();
  user.followerHistory.push({ time: now, value });
  if (user.followerHistory.length > MONITOR_HISTORY_LIMIT) {
    user.followerHistory = user.followerHistory.slice(-MONITOR_HISTORY_LIMIT);
  }
}

// 向视频记录追加数据历史快照点（点赞/评论）
function pushVideoStatsHistory(video, diggCount, commentCount) {
  if (!Array.isArray(video.statsHistory)) video.statsHistory = [];
  const now = Date.now();
  video.statsHistory.push({ time: now, diggCount, commentCount });
  if (video.statsHistory.length > MONITOR_HISTORY_LIMIT) {
    video.statsHistory = video.statsHistory.slice(-MONITOR_HISTORY_LIMIT);
  }
}

// 发送监控更新事件给前端
function emitMonitorUpdated() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('monitor-updated', {
      users: monitorUsers,
      videos: monitorVideos,
    });
  }
}

// Server酱 微信推送：fire-and-forget，失败只记日志不干扰监控主流程
// title 最长 32（Server酱限制），desp 支持 Markdown 但这里用纯文本
async function sendServerChan(title, desp) {
  const sc = monitorConfig.serverChan;
  if (!sc || !sc.enabled || !sc.sctkey) return;
  try {
    await axios.post(`https://sctapi.ftqq.com/${sc.sctkey}.send`,
      { title: String(title || '抖音监控').slice(0, 32), desp: String(desp || '') },
      { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
    console.log('[ServerChan] 推送成功:', String(title).slice(0, 32));
  } catch (e) {
    console.error('[ServerChan] 推送失败:', e.message);
  }
}

// 记录一条监控事件 + 系统通知 + 推送前端
// 监控开关(monitorTypes): 关闭 -> 整条事件丢弃，不记录不推送
// 推送开关(pushTypes):     关闭 -> 仍记录到列表，但不弹系统通知（红点由前端按 pushTypes 过滤）
function addMonitorEvent(event) {
  const t = event.type;
  // 全局类型监控开关：该类型关闭则整条丢弃
  if (t && monitorConfig.monitorTypes && monitorConfig.monitorTypes[t] === false) {
    return null;
  }

  const fullEvent = { id: Date.now().toString() + Math.random().toString(36).slice(2, 7), time: Date.now(), read: false, ...event };
  monitorEvents.unshift(fullEvent);
  if (monitorEvents.length > 200) monitorEvents = monitorEvents.slice(0, 200);
  db.addMonitorEvent(fullEvent);

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('monitor-event', fullEvent);
  }

  // 系统通知 + Server酱：受 pushTypes 控制（红点也归推送，前端按 pushTypes 过滤）
  const shouldPush = !t || !monitorConfig.pushTypes || monitorConfig.pushTypes[t] !== false;
  if (shouldPush) {
    try {
      if (Notification.isSupported()) {
        new Notification({ title: event.title || '抖音监控', body: event.message || '' }).show();
      }
    } catch (e) { /* ignore */ }
    // Server酱 微信推送（与系统弹窗同进退，复用 shouldPush 判定）
    sendServerChan(event.title || '抖音监控', event.message || '');
  }

  return fullEvent;
}

// 从输入（主页链接/短链/sec_user_id）解析 sec_user_id
async function resolveSecUserId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // 直接含 user/xxx
  let m = raw.match(/user\/([^?&/]+)/);
  if (m) return m[1];

  // 短链解析
  const urlMatch = raw.match(/https?:\/\/\S+/);
  if (urlMatch) {
    try {
      const resolved = await douyinAPI.resolveShareLink(urlMatch[0]);
      if (resolved && typeof resolved === 'string') {
        m = resolved.match(/user\/([^?&/]+)/);
        if (m) return m[1];
      }
    } catch (e) {
      console.warn('[Monitor] 解析用户链接失败:', e.message);
    }
  }

  // 兜底：本身就是 sec_user_id
  if (/^MS4[\w-]+$/.test(raw)) return raw;
  return null;
}

// 从输入（视频链接/短链/aweme_id）解析 aweme_id
async function resolveAwemeId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (/^\d{6,}$/.test(raw)) return raw;

  let m = raw.match(/(?:video|note)\/(\d+)/);
  if (m) return m[1];

  const urlMatch = raw.match(/https?:\/\/\S+/);
  if (urlMatch) {
    try {
      const resolved = await douyinAPI.resolveShareLink(urlMatch[0]);
      if (resolved && typeof resolved === 'string') {
        m = resolved.match(/(?:video|note)\/(\d+)/) || resolved.match(/modal_id=(\d+)/);
        if (m) return m[1];
      }
    } catch (e) {
      console.warn('[Monitor] 解析视频链接失败:', e.message);
    }
  }

  m = raw.match(/(\d{15,})/);
  return m ? m[1] : null;
}

// 取用户主页第一页作品（用于检测新视频）
async function fetchFirstPageVideos(secUserId) {
  try {
    const result = await douyinAPI.getUserVideos(secUserId, 0, 20);
    if (result && Array.isArray(result.aweme_list)) return result.aweme_list;
    if (result && result.data && Array.isArray(result.data.aweme_list)) return result.data.aweme_list;
  } catch (e) {
    console.warn('[Monitor] 获取用户作品失败:', e.message);
  }
  return [];
}

// 提取粉丝数
function extractFollowerCount(u) {
  if (!u) return null;
  if (typeof u.follower_count === 'number') return u.follower_count;
  if (typeof u.mplatform_followers_count === 'number') return u.mplatform_followers_count;
  return null;
}

// 检查单个关注用户
async function checkMonitorUser(user) {
  const profile = await douyinAPI.getUserProfile(user.secUserId);
  const u = profile && profile.user;
  if (!u) {
    console.warn('[Monitor] 用户信息为空:', user.secUserId);
    return;
  }

  const newFollower = extractFollowerCount(u);
  const newAwemeCount = typeof u.aweme_count === 'number' ? u.aweme_count : user.awemeCount;
  user.nickname = u.nickname || user.nickname;
  if (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0]) {
    user.avatar = u.avatar_thumb.url_list[0];
  }

  // 粉丝数变化
  if (user.notifyFollower && typeof user.followerCount === 'number' && typeof newFollower === 'number' && newFollower !== user.followerCount) {
    const diff = newFollower - user.followerCount;
    addMonitorEvent({
      type: 'follower',
      secUserId: user.secUserId,
      nickname: user.nickname,
      title: `${user.nickname} 粉丝${diff > 0 ? '增加' : '减少'}`,
      message: `${diff > 0 ? '+' : ''}${diff}，当前 ${newFollower} 粉丝`,
      diff,
      value: newFollower,
    });
  }
  if (typeof newFollower === 'number') {
    user.followerCount = newFollower;
    pushFollowerHistory(user, newFollower);
  }

  // 新视频检测
  if (user.notifyNewVideo) {
    const videos = await fetchFirstPageVideos(user.secUserId);
    if (videos.length > 0) {
      const times = videos.map(v => v.create_time || 0);
      const maxTime = Math.max(...times);

      // 已有基线时才报新视频，避免首次添加刷屏
      if (user.lastAwemeTime) {
        const newOnes = videos
          .filter(v => (v.create_time || 0) > user.lastAwemeTime)
          .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
        for (const v of newOnes) {
          addMonitorEvent({
            type: 'new_video',
            secUserId: user.secUserId,
            nickname: user.nickname,
            awemeId: v.aweme_id,
            title: `${user.nickname} 发布了新作品`,
            message: (v.desc || '无标题').slice(0, 50),
            createTime: v.create_time,
          });
        }
      }
      user.lastAwemeTime = Math.max(user.lastAwemeTime || 0, maxTime);
      // lastAwemeId 应取 create_time 最大的那条，而非列表首项（列表不一定按时间倒序）
      const latest = videos.reduce((a, b) => ((b.create_time || 0) > (a.create_time || 0) ? b : a), videos[0]);
      user.lastAwemeId = latest.aweme_id;
    }
  }

  user.awemeCount = newAwemeCount;
  user.lastChecked = Date.now();
}

// 检查单个关注视频
async function checkMonitorVideo(video) {
  const detail = await douyinAPI.getVideoDetail(video.awemeId);
  const d = detail && (detail.aweme_detail || detail);
  const stats = d && d.statistics;
  if (!stats) return;

  const newDigg = stats.digg_count ?? video.diggCount;
  const newComment = stats.comment_count ?? video.commentCount;

  if (typeof video.diggCount === 'number' && newDigg !== video.diggCount) {
    const diff = newDigg - video.diggCount;
    addMonitorEvent({
      type: 'video_digg',
      awemeId: video.awemeId,
      title: `作品点赞${diff > 0 ? '增加' : '变化'}`,
      message: `「${(video.desc || '').slice(0, 20)}」 ${diff > 0 ? '+' : ''}${diff}，共 ${newDigg} 赞`,
      diff,
      value: newDigg,
    });
  }

  video.diggCount = newDigg;
  video.commentCount = newComment;
  pushVideoStatsHistory(video, newDigg, newComment);
  if (d.desc) video.desc = d.desc;
  if (d.author && d.author.nickname) video.author = d.author.nickname;
  video.lastChecked = Date.now();
}

// 检查账号管理中的账号：抓取个人资料 + 作品列表，更新账号字段 + 写入账号增速历史 + 作品统计时序
// 每个账号每轮 2 次请求（getUserProfile + getUserVideos），与监控用户复用同一周期。
async function checkAccount(acc, apiInstance) {
  if (!acc || !acc.sec_user_id) return;
  const secUserId = acc.sec_user_id;
  // 默认用全局 douyinAPI；「我的账号」可传账号专属 API 实例（用自己的 cookie 才能看到播放量）
  const api = apiInstance || douyinAPI;

  // 1) 个人资料
  const profile = await api.getUserProfile(secUserId);
  const u = profile && profile.user;
  if (!u) {
    console.warn('[Account] 用户信息为空:', secUserId);
    return;
  }
  const patch = {
    nickname: u.nickname || acc.nickname,
    unique_id: u.unique_id || u.short_id || acc.unique_id,
    avatar: (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0]) || acc.avatar,
    signature: u.signature || acc.signature,
    follower_count: typeof u.follower_count === 'number' ? u.follower_count : (u.mplatform_followers_count || acc.follower_count),
    following_count: typeof u.following_count === 'number' ? u.following_count : acc.following_count,
    total_favorited: typeof u.total_favorited === 'number' ? u.total_favorited : acc.total_favorited,
    aweme_count: typeof u.aweme_count === 'number' ? u.aweme_count : acc.aweme_count,
    favoriting_count: typeof u.favoriting_count === 'number' ? u.favoriting_count : acc.favoriting_count,
  };
  // 更新账号快照（不写历史，历史由下方 pushAccountSnapshot 单独维护）
  db.updateAccount(secUserId, patch);
  // 追加账号增速历史点（粉丝/获赞/作品数等）
  db.pushAccountSnapshot(secUserId, {
    follower_count: patch.follower_count,
    following_count: patch.following_count,
    total_favorited: patch.total_favorited,
    aweme_count: patch.aweme_count,
    favoriting_count: patch.favoriting_count,
  });

  // 2) 作品列表（列表接口一次返回该账号所有作品的统计，无需逐个请求）
  const list = await api.getUserVideos(secUserId, 0, 20);
  const awemeList = (list && Array.isArray(list.aweme_list)) ? list.aweme_list
    : (list && list.data && Array.isArray(list.data.aweme_list)) ? list.data.aweme_list : [];
  const numStat = (v, key) => (v.statistics && typeof v.statistics[key] === 'number') ? v.statistics[key] : 0;
  const works = awemeList.map(v => ({
    aweme_id: v.aweme_id,
    desc: v.desc || '',
    cover: (v.video && v.video.cover && v.video.cover.url_list && v.video.cover.url_list[0]) || '',
    create_time: v.create_time || 0,
    digg_count: numStat(v, 'digg_count'),
    comment_count: numStat(v, 'comment_count'),
    play_count: numStat(v, 'play_count'),
    share_count: numStat(v, 'share_count'),
    collect_count: numStat(v, 'collect_count'),
  }));
  db.upsertAccountWorks(secUserId, works);
}

// 推送账号更新事件到前端（账号列表 / 弹窗数据刷新）
function emitAccountUpdated() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('account-updated', { accounts: db.listAccounts() });
  }
}

// 执行一轮监控
async function runMonitorCycle() {
  if (monitorRunning) return;
  monitorRunning = true;
  console.log('[Monitor] 开始检查, 用户:', monitorUsers.length, '视频:', monitorVideos.length);

  try {
    for (const user of monitorUsers) {
      try {
        await checkMonitorUser(user);
      } catch (e) {
        console.error('[Monitor] 检查用户失败:', user.secUserId, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    for (const video of monitorVideos) {
      try {
        await checkMonitorVideo(video);
      } catch (e) {
        console.error('[Monitor] 检查视频失败:', video.awemeId, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    saveMonitorUsers();
    saveMonitorVideos();
    // 整体持久化到 SQLite（以内存态为准覆盖 DB）
    db.persistMonitorState(monitorUsers, monitorVideos);
    emitMonitorUpdated();

    // 账号管理：复用同一周期抓取账号增速 + 作品统计时序
    // 每个账号 2 次请求（资料 + 作品列表），之间留 1.5s 节流
    const accounts = db.listAccounts();
    if (accounts.length) {
      console.log('[Monitor] 检查账号管理账号, 数量:', accounts.length);
      for (const acc of accounts) {
        try {
          await checkAccount(acc);
        } catch (e) {
          console.error('[Monitor] 检查账号失败:', acc.sec_user_id, e.message);
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      db.flushNow();
      emitAccountUpdated();
    }
  } finally {
    monitorRunning = false;
    console.log('[Monitor] 本轮检查完成');
  }
}

function startMonitor() {
  stopMonitor();
  if (!monitorConfig.enabled) {
    console.log('[Monitor] 监控已禁用');
    return;
  }
  const interval = Math.max(1, Number(monitorConfig.intervalMinutes) || 10) * 60 * 1000;
  monitorTimer = setInterval(runMonitorCycle, interval);
  console.log('[Monitor] 监控已启动, 间隔(分钟):', monitorConfig.intervalMinutes);
  // 启动后延迟首检，避免与启动流程争抢
  monitorFirstCheckTimer = setTimeout(() => {
    monitorFirstCheckTimer = null;
    runMonitorCycle();
  }, 5000);
}

function stopMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (monitorFirstCheckTimer) {
    clearTimeout(monitorFirstCheckTimer);
    monitorFirstCheckTimer = null;
  }
}

// ===== 账号管理 IPC =====

// 列出所有账号
ipcMain.handle('account-list', async () => {
  try {
    return { success: true, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Account] 列出失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 添加账号
ipcMain.handle('account-add', async (event, accountData) => {
  try {
    if (!accountData || !accountData.sec_user_id) {
      return { success: false, error: '账号数据不完整' };
    }
    db.addAccount(accountData);

    // 写入初始增速历史点
    db.pushAccountSnapshot(accountData.sec_user_id, {
      follower_count: accountData.follower_count,
      following_count: accountData.following_count,
      total_favorited: accountData.total_favorited,
      aweme_count: accountData.aweme_count,
      favoriting_count: accountData.favoriting_count,
    });

    // 立即拉取一次该账号作品与最新增速时序
    try {
      const accounts = db.listAccounts();
      const acc = accounts.find(a => a.sec_user_id === accountData.sec_user_id);
      if (acc) {
        await checkAccount(acc);
      }
    } catch (e) {
      console.warn('[Account] 初始同步失败:', e.message);
    }

    return { success: true, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Account] 添加失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 删除账号
ipcMain.handle('account-remove', async (event, secUserId) => {
  try {
    db.removeAccount(secUserId);
    return { success: true, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Account] 删除失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 更新账号元信息（置顶 / 标签 / 备注）
ipcMain.handle('account-update-meta', async (event, { secUserId, patch }) => {
  try {
    db.updateAccountMeta(secUserId, patch);
    return { success: true, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Account] 更新元信息失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 主页下载历史记录 IPC =====
// 按 sec_user_id 去重（INSERT OR REPLACE 覆盖）；videos 存完整 aweme 数组

// ===== 我的账号（运营专区：绑定自己的抖音账号，用各自 cookie 才能看到播放量） =====

// 把 accounts 表或自身属性上的账号快照（粉丝/关注/获赞/作品/喜欢/签名/抖音号）合并到我的账号列表上，
// 这样前端卡片能展示一致的统计行。
function enrichMyAccounts() {
  const myList = db.listMyAccounts();
  const accMap = new Map(db.listAccounts().map(a => [a.sec_user_id, a]));
  return myList.map(m => {
    const acc = m.sec_uid ? accMap.get(m.sec_uid) : null;
    return {
      ...m,
      unique_id: (acc && acc.unique_id) || m.unique_id || '',
      signature: (acc && acc.signature) || m.signature || '',
      follower_count: (acc && acc.follower_count) || m.follower_count || 0,
      following_count: (acc && acc.following_count) || m.following_count || 0,
      total_favorited: (acc && acc.total_favorited) || m.total_favorited || 0,
      aweme_count: (acc && acc.aweme_count) || m.aweme_count || 0,
      favoriting_count: (acc && acc.favoriting_count) || m.favoriting_count || 0,
    };
  });
}

// 用指定 cookie 识别当前登录账号身份 + 绑定存储到我的账号（不自动同步到账号管理）
// cookie 来自登录窗口或全局 cookie_douyin。返回 { myAccounts }
async function bindMyAccountWithCookie(cookie) {
  const api = createDouyinAPIWithCookie(cookie);
  // 1) 识别当前登录账号身份
  const self = await api.request('https://www.douyin.com/aweme/v1/web/user/profile/self/', {});
  const user = self && self.user;
  if (!user || !user.uid) {
    throw new Error('无法识别登录账号（可能未登录或登录态失效），请重新登录');
  }
  const uid = String(user.uid);
  const secUid = user.sec_uid || '';
  const nickname = user.nickname || '未知账号';
  const avatar = (user.avatar_thumb && user.avatar_thumb.url_list && user.avatar_thumb.url_list[0]) || '';
  const uniqueId = user.unique_id || user.short_id || '';
  const signature = user.signature || '';
  const followerCount = user.follower_count || 0;
  const followingCount = user.following_count || 0;
  const totalFavorited = user.total_favorited || 0;
  const awemeCount = user.aweme_count || 0;
  const favoritingCount = user.favoriting_count || 0;

  // 2) 存入我的账号
  db.addMyAccount({
    uid,
    sec_uid: secUid,
    nickname,
    avatar,
    added_time: Date.now(),
    unique_id: uniqueId,
    signature,
    follower_count: followerCount,
    following_count: followingCount,
    total_favorited: totalFavorited,
    aweme_count: awemeCount,
    favoriting_count: favoritingCount,
  });
  db.setMyAccountSecret(uid, cookie);

  // 3) 作品与增速快照写入 DB（account_works / account_history），供增速弹窗/爆款分析读取。
  //    注意：不写入 accounts 表 —— 我的账号与账号管理是两个独立列表，避免相互污染
  if (secUid) {
    try {
      const list = await api.getUserVideos(secUid, 0, 30);
      const awemeList = (list && Array.isArray(list.aweme_list)) ? list.aweme_list
        : (list && list.data && Array.isArray(list.data.aweme_list)) ? list.data.aweme_list : [];
      if (awemeList.length > 0) {
        db.upsertAccountWorks(secUid, awemeList);
        db.pushAccountSnapshot(secUid, {
          follower_count: followerCount,
          following_count: followingCount,
          total_favorited: totalFavorited,
          aweme_count: awemeCount,
          favoriting_count: favoritingCount,
        });
      }
    } catch (e) {
      console.warn('[MyAccount] 初始抓取作品写库警告:', e.message);
    }
  }

  return enrichMyAccounts();
}

// 列出我的账号
ipcMain.handle('my-account-list', async () => {
  try {
    return { success: true, myAccounts: enrichMyAccounts() };
  } catch (error) {
    console.error('[MyAccount] 列出失败:', error.message);
    return { success: false, error: error.message, myAccounts: [] };
  }
});

// 绑定新账号：弹登录窗口，登录成功后识别并绑定
ipcMain.handle('my-account-bind-login', async () => {
  try {
    const cookies = await cookieManager.openLoginWindow('douyin');
    if (!cookies || !cookies.cookieString) {
      return { success: false, error: '未获取到登录 Cookie' };
    }
    const myAccounts = await bindMyAccountWithCookie(cookies.cookieString);
    return { success: true, myAccounts };
  } catch (error) {
    console.error('[MyAccount] 登录绑定失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 绑定当前全局登录账号（用 cookie_douyin）
ipcMain.handle('my-account-bind-current', async () => {
  try {
    const cookie = readKV('cookie_douyin', '');
    if (!cookie) {
      return { success: false, error: '当前未登录抖音账号，请先通过「登录平台账号」登录' };
    }
    const myAccounts = await bindMyAccountWithCookie(cookie);
    return { success: true, myAccounts };
  } catch (error) {
    console.error('[MyAccount] 绑定当前账号失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 移除我的账号（只删除 my_accounts 中的记录，不动账号管理）
ipcMain.handle('my-account-remove', async (event, uid) => {
  try {
    db.removeMyAccount(String(uid));
    return { success: true, myAccounts: enrichMyAccounts() };
  } catch (error) {
    console.error('[MyAccount] 移除失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 刷新我的账号：更新资料与数据快照及作品库
ipcMain.handle('my-account-refresh', async (event, uid) => {
  try {
    const my = db.listMyAccounts().find(a => a.uid === String(uid));
    if (!my) return { success: false, error: '账号不存在' };
    const accountSecret = db.getMyAccountSecret(my.uid);
    if (!accountSecret) return { success: false, error: '该账号登录态已清除，请重新绑定' };
    const api = createDouyinAPIWithCookie(accountSecret);
    const self = await api.request('https://www.douyin.com/aweme/v1/web/user/profile/self/', {});
    const user = self && self.user;
    if (user) {
      const updatedMy = {
        ...my,
        nickname: user.nickname || my.nickname,
        avatar: (user.avatar_thumb && user.avatar_thumb.url_list && user.avatar_thumb.url_list[0]) || my.avatar,
        unique_id: user.unique_id || user.short_id || my.unique_id,
        signature: user.signature || my.signature,
        follower_count: user.follower_count ?? my.follower_count,
        following_count: user.following_count ?? my.following_count,
        total_favorited: user.total_favorited ?? my.total_favorited,
        aweme_count: user.aweme_count ?? my.aweme_count,
        favoriting_count: user.favoriting_count ?? my.favoriting_count,
      };
      db.addMyAccount(updatedMy);

      // 只写作品/增速快照（account_works / account_history），不写 accounts 表，
      // 保持「我的账号」与「账号管理」两个列表相互独立
      if (my.sec_uid) {
        try {
          const list = await api.getUserVideos(my.sec_uid, 0, 30);
          const awemeList = (list && Array.isArray(list.aweme_list)) ? list.aweme_list
            : (list && list.data && Array.isArray(list.data.aweme_list)) ? list.data.aweme_list : [];
          if (awemeList.length > 0) {
            db.upsertAccountWorks(my.sec_uid, awemeList);
            db.pushAccountSnapshot(my.sec_uid, {
              follower_count: updatedMy.follower_count,
              following_count: updatedMy.following_count,
              total_favorited: updatedMy.total_favorited,
              aweme_count: updatedMy.aweme_count,
              favoriting_count: updatedMy.favoriting_count,
            });
          }
        } catch (workErr) {
          console.warn('[MyAccount] 刷新作品写入数据库警告:', workErr.message);
        }
      }
    }
    return { success: true, myAccounts: enrichMyAccounts() };
  } catch (error) {
    console.error('[MyAccount] 刷新失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 用我的账号 cookie 实时抓取作品列表（展开作品用，播放量有值，并落库供头像/爆款分析使用）
// 我的账号作品列表（支持分页，cursor 翻页；用该账号自己的 cookie 抓取 → 播放量有值）
ipcMain.handle('my-account-works', async (event, uid, cursor = 0, count = 30) => {
  try {
    const my = db.listMyAccounts().find(a => a.uid === String(uid));
    if (!my) return { success: false, error: '账号不存在' };
    if (!my.sec_uid) return { success: false, error: '该账号缺少 sec_uid' };
    const accountSecret = db.getMyAccountSecret(my.uid);
    if (!accountSecret) return { success: false, error: '该账号登录态已清除，请重新绑定' };
    const api = createDouyinAPIWithCookie(accountSecret);
    const list = await api.getUserVideos(my.sec_uid, cursor || 0, count || 30);
    const awemeList = (list && Array.isArray(list.aweme_list)) ? list.aweme_list
      : (list && list.data && Array.isArray(list.data.aweme_list)) ? list.data.aweme_list : [];
    const nextCursor = (list && (list.max_cursor || list.data?.max_cursor)) || 0;
    const rawHasMore = list && (list.has_more ?? list.data?.has_more);
    const hasMore = rawHasMore === 1 || rawHasMore === true || rawHasMore === '1' || (awemeList.length >= (count || 30) && Number(nextCursor) !== Number(cursor));

    // 落地写库：只写 account_works / account_history（供增速/爆款分析），不写 accounts 表，
    // 避免「我的账号」出现在「账号管理」列表中
    if (awemeList.length > 0 && !cursor) {
      db.upsertAccountWorks(my.sec_uid, awemeList);
      db.pushAccountSnapshot(my.sec_uid, {
        follower_count: my.follower_count,
        following_count: my.following_count,
        total_favorited: my.total_favorited,
        aweme_count: my.aweme_count,
        favoriting_count: my.favoriting_count,
      });
    }

    return { success: true, works: awemeList, hasMore, cursor: nextCursor };
  } catch (error) {
    console.error('[MyAccount] 抓取作品失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 列出全部历史记录（按 updated_time 倒序）
ipcMain.handle('profile-history-list', async () => {
  try {
    return { success: true, history: db.listProfileHistory() };
  } catch (error) {
    console.error('[ProfileHistory] 列出失败:', error.message);
    return { success: false, error: error.message, history: [] };
  }
});

// 保存/更新一条历史记录（抓取成功后调用）
// h: { secUserId, nickname, avatar, uniqueId, videos, videoCount, downloadType, sourceUrl, platform }
ipcMain.handle('profile-history-add', async (event, h) => {
  try {
    if (!h || !h.secUserId) {
      return { success: false, error: '缺少 sec_user_id' };
    }
    db.upsertProfileHistory(h);
    return { success: true, history: db.listProfileHistory() };
  } catch (error) {
    console.error('[ProfileHistory] 保存失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 删除单条历史记录（key = sec_user_id 或 sec_user_id:collection）
ipcMain.handle('profile-history-remove', async (event, key) => {
  try {
    db.removeProfileHistory(key);
    return { success: true, history: db.listProfileHistory() };
  } catch (error) {
    console.error('[ProfileHistory] 删除失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 清空全部历史记录
ipcMain.handle('profile-history-clear', async () => {
  try {
    db.clearProfileHistory();
    return { success: true, history: [] };
  } catch (error) {
    console.error('[ProfileHistory] 清空失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 账号分组 IPC =====

// 列出所有分组（含每组账号数）
ipcMain.handle('group-list', async (event, scope) => {
  try {
    return { success: true, groups: db.listGroups(scope) };
  } catch (error) {
    console.error('[Group] 列出失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 新建分组（兼容旧调用：字符串 name；新调用：{name, color, scope}）
ipcMain.handle('group-add', async (event, arg) => {
  try {
    const groups = db.addGroup(arg);
    return { success: true, groups };
  } catch (error) {
    console.error('[Group] 新建失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 重命名分组
ipcMain.handle('group-rename', async (event, { id, name }) => {
  try {
    const groups = db.renameGroup(id, name);
    return { success: true, groups };
  } catch (error) {
    console.error('[Group] 重命名失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 更新分组颜色
ipcMain.handle('group-update-color', async (event, { id, color }) => {
  try {
    const groups = db.updateGroupColor(id, color);
    return { success: true, groups };
  } catch (error) {
    console.error('[Group] 更新颜色失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 删除分组（组内成员归未分组）
ipcMain.handle('group-remove', async (event, id) => {
  try {
    const groups = db.removeGroup(id);
    return {
      success: true,
      groups,
      accounts: db.listAccounts(),
      users: db.listMonitorUsers(),
      videos: db.listMonitorVideos(),
    };
  } catch (error) {
    console.error('[Group] 删除失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 把账号移到指定分组（groupId 为 null/空 -> 未分组）
ipcMain.handle('group-move-account', async (event, { secUserId, groupId }) => {
  try {
    db.moveAccountToGroup(secUserId, groupId);
    return { success: true, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Group] 移动账号失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 把监控用户移到分组
ipcMain.handle('group-move-monitor-user', async (event, { secUserId, groupId }) => {
  try {
    db.moveMonitorUserToGroup(secUserId, groupId);
    const users = db.listMonitorUsers();
    monitorUsers = users;
    return { success: true, users };
  } catch (error) {
    console.error('[Group] 移动监控用户失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 把监控视频移到分组
ipcMain.handle('group-move-monitor-video', async (event, { awemeId, groupId }) => {
  try {
    db.moveMonitorVideoToGroup(awemeId, groupId);
    const videos = db.listMonitorVideos();
    monitorVideos = videos;
    return { success: true, videos };
  } catch (error) {
    console.error('[Group] 移动监控视频失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 更新监控用户备注/标签/置顶
ipcMain.handle('monitor-update-user-meta', async (event, { secUserId, patch }) => {
  try {
    db.updateMonitorUserMeta(secUserId, patch || {});
    const users = db.listMonitorUsers();
    monitorUsers = users;
    return { success: true, users };
  } catch (error) {
    console.error('[Monitor] 更新用户备注失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 更新监控视频备注/标签/置顶
ipcMain.handle('monitor-update-video-meta', async (event, { awemeId, patch }) => {
  try {
    db.updateMonitorVideoMeta(awemeId, patch || {});
    const videos = db.listMonitorVideos();
    monitorVideos = videos;
    return { success: true, videos };
  } catch (error) {
    console.error('[Monitor] 更新视频备注失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 哔哩哔哩直播 =====
// 获取 B 站直播间信息（标题/主播/是否开播/流地址）
ipcMain.handle('bili-get-live-stream', async (event, input) => {
  try {
    const biliLive = new BiliLiveAPI();
    const info = await biliLive.getRoomInfo(input);
    return { success: true, data: info };
  } catch (error) {
    console.error('[BiliLive] 获取失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 红果短剧批量下载 IPC =====
ipcMain.handle('hongguo-resolve', async (event, input) => {
  try {
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    return { success: true, data };
  } catch (error) {
    console.error('[Hongguo] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('hongguo-download-batch', async (event, payload) => {
  try {
    const { seriesId, seriesTitle, episodes } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }

    const cleanSeriesTitle = sanitizeFolderName(seriesTitle || '红果短剧');
    const settings = db.getKV('settings', {}) || {};
    const fallback = app.getPath('downloads');
    const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : fallback;
    const downloadDir = path.join(root, '红果短剧', cleanSeriesTitle);
    try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) {}

    const batchId = 'hongguobatch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const firstCover = (episodes[0] && episodes[0].cover) || '';

    const batchInfo = {
      batchId,
      platform: 'hongguo',
      nickname: `《${cleanSeriesTitle}》`,
      avatar: firstCover,
      profileUrl: '',
      totalCount: episodes.length,
      createTime: Date.now(),
    };

    const addedCount = episodes.length;
    for (const ep of episodes) {
      const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      const epIndexStr = String(ep.vid_index).padStart(3, '0');
      const filename = `${cleanSeriesTitle}_第${epIndexStr}集.mp4`;
      const finalPath = path.join(downloadDir, filename);

      const task = {
        id: taskId,
        batchId,
        batchInfo,
        savePath: finalPath,
        customDir: downloadDir,
        title: `《${cleanSeriesTitle}》第${epIndexStr}集${ep.title ? ' ' + ep.title : ''}`,
        filename,
        platform: 'hongguo',
        type: 'hongguo',
        status: 'pending',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        startTime: Date.now(),
        videoInfo: {
          author: cleanSeriesTitle,
          title: `《${cleanSeriesTitle}》第${epIndexStr}集`,
          cover: ep.cover || firstCover,
          aweme_id: ep.vid,
        },
        hongguoInfo: {
          vid: ep.vid,
          series_id: seriesId,
          series_title: cleanSeriesTitle,
          vid_index: ep.vid_index,
          ep_title: ep.title,
        }
      };

      downloadTasks.unshift(task);
      enqueueDownload(task);

      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-task-added', task);
      }
    }

    saveDownloadTasks();

    return { success: true, count: addedCount };
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 小红书主页批量下载 =====
// 抓取主页全部作品列表（隐藏窗口 + 拦截 user_posted 响应，绕过 x-s 签名）
ipcMain.handle('xhs-profile-list', async (event, profileUrl, maxPages = 999) => {
  const fetchStart = Date.now();
  try {
    const { user, notes, truncated, fetchedPages, stopReason } = await xhsProfile.fetchUserNotes(profileUrl, (p) => {
      // 推给发起本次抓取的渲染进程（精准定向，不广播）
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('xhs-profile-progress', p);
      }
    }, maxPages);
    const elapsed = ((Date.now() - fetchStart) / 1000).toFixed(1);
    console.log('[XhsProfile] xhs-profile-list 完成: notes=%d pages=%d truncated=%s stopReason=%s 耗时=%ss',
      notes.length, fetchedPages, truncated, stopReason, elapsed);
    // 诊断日志写入文件（便于排查"数量不对"类问题，用户可提供此文件）
    try {
      const diagPath = path.join(app.getPath('userData'), 'xhs_fetch_diag.log');
      const line = `[${new Date().toISOString()}] url=${profileUrl.slice(0, 60)}... maxPages=${maxPages} -> notes=${notes.length} pages=${fetchedPages} truncated=${truncated} stopReason=${stopReason} 耗时=${elapsed}s\n`;
      fs.appendFileSync(diagPath, line, 'utf8');
      console.log('[XhsProfile] 诊断日志已写入:', diagPath);
    } catch (e) {}
    return { success: true, data: { user, notes, truncated, fetchedPages, stopReason } };
  } catch (error) {
    console.error('[XhsProfile] 抓取失败:', error.message);
    // 未登录特殊标记，前端引导用户登录
    if (error.message === 'NO_COOKIE') {
      return { success: false, error: 'NO_COOKIE', needLogin: true };
    }
    return { success: false, error: error.message };
  }
});

// ===== 快手主页作品列表抓取（纯 HTTP 逆向 GraphQL）=====
// 需先在「登录平台账号」登录快手，cookie 存入 DB (cookie_kuaishou)
// 返回 { success, user, videos } ，videos 为与抖音 aweme 兼容的结构，可直接复用下载逻辑
ipcMain.handle('ks-profile-list', async (event, profileUrl, maxPages = 20) => {
  try {
    const result = await kuaishouProfile.fetchProfile(profileUrl, maxPages, (p) => {
      // 逐页进度推给发起本次抓取的渲染进程
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('ks-profile-progress', p);
      }
    });
    return result;
  } catch (error) {
    console.error('[KsProfile] 抓取失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== B 站主页投稿作品列表抓取（纯 HTTP + Wbi 签名）=====
// 无需登录即可抓取公开投稿列表；cookie_bilibili（SESSDATA）可选，仅用于更完整数据/高清下载
// 返回 { success, user, videos } ，videos 为 B 站视频卡片结构（bvid/title/watch_url），下载走 yt-dlp
ipcMain.handle('bili-profile-list', async (event, profileUrl, maxPages = 20) => {
  try {
    const result = await bilibiliProfile.fetchProfile(profileUrl, maxPages, (p) => {
      // 逐页进度推给发起本次抓取的渲染进程
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('bili-profile-progress', p);
      }
    });
    return result;
  } catch (error) {
    console.error('[BiliProfile] 抓取失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== B 站视频完整 DASH 流解析（猫抓方案专用，纯 HTTP）=====
// 不依赖浏览器播放器是否加载：view 接口拿 cid + playurl wbi 接口拿全部清晰度音视频流
ipcMain.handle('bili-play-streams', async (event, urlOrBvid) => {
  try {
    const result = await bilibiliProfile.fetchStreams(urlOrBvid);
    return result;
  } catch (error) {
    console.error('[BiliPlay] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 通用网页嗅探（通用下载器）=====
// 打开可见嗅探窗口，捕获页面加载的所有媒体资源（视频/音频/图片/m3u8），
// 通过 webContents.send('sniff-resource') 实时推送，窗口关闭时推送 sniff-stopped
ipcMain.handle('sniff-start', async (event, winUrl) => {
  const res = universalSniffer.start(winUrl, {
    onResource: (r) => {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('sniff-resource', r);
      }
    },
    onStatus: (text) => {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('sniff-status', text);
      }
    },
    onWindowClosed: () => {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('sniff-stopped');
      }
    },
  });
  return res;
});

ipcMain.handle('sniff-stop', () => {
  universalSniffer.stop();
  return { success: true };
});

ipcMain.handle('sniff-status', () => {
  return { running: universalSniffer.isRunning() };
});

// 获取单条笔记详情（feed API，含视频流/图集URL）
// 前端单条解析时调用，传 {noteId, xsecToken}
ipcMain.handle('xhs-profile-detail', async (event, param) => {
  try {
    // 兼容旧调用：传字符串 noteId
    const noteCard = await xhsProfile.fetchNoteDetail(param);
    if (!noteCard) {
      return { success: false, error: '笔记不存在或已被删除' };
    }
    // 用抽出的独立函数解析成统一下载结构（兼容驼峰/下划线）
    const data = parseNoteCard(noteCard);
    return { success: true, data };
  } catch (error) {
    console.error('[XhsProfile] 获取详情失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 文件名安全化（与各业务页一致的规则：去非法字符 + 限长）
function safeXhsName(s) {
  return (s || '笔记').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 60);
}

/**
 * 小红书主页下载的专属目录：下载根目录/小红书/主页/作者名/
 *
 * 与通用 getDownloadDir 不同，这里固定按「平台/来源/作者」三层归类，
 * 不受 settings.folder_name / settings.folder_mode 影响（那两个是通用设置，
 * 对小红书主页这种批量场景反而会让目录层级混乱）。
 * 尊重 settings.root（用户设置的下载根目录）。
 *
 * @param {Object} videoInfo - { author } 作者名
 * @returns {string} 目录绝对路径（已创建）
 */
function getXhsCustomDir(videoInfo) {
  const settings = db.getKV('settings', {}) || {};
  const fallback = app.getPath('downloads');
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : fallback;
  const author = sanitizeFolderName(videoInfo && videoInfo.author) || '未知作者';
  const dir = path.join(root, '小红书', '主页', author);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (error) {
    console.error('[XhsProfile] 创建目录失败，回退到下载根目录:', error.message);
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) { /* ignore */ }
    return root;
  }
}

// 批量下载小红书笔记：前端点"下载选中"后一次性提交全部选中笔记，
// 主进程立即把它们添加为 parsing 占位任务（下载管理页实时显示"解析中"），
// 然后后台并发解析（feed API）-> 解析完自动转成真实下载任务入队下载。
//
// notes: [{ noteId, xsecToken, title, cover, author:{name} }]（来自主页勾选的 normalizeNote 结构）
// payload: { notes, profileUrl, userInfo } —— profileUrl/userInfo 用于下载管理页分组展示
ipcMain.handle('xhs-profile-download-batch', async (event, payload) => {
  try {
    // 兼容旧调用：直接传数组
    const notes = Array.isArray(payload) ? payload : (payload && payload.notes);
    const profileUrl = (payload && payload.profileUrl) || '';
    const userInfo = (payload && payload.userInfo) || {};
    if (!Array.isArray(notes) || notes.length === 0) {
      return { success: false, error: '没有选中的笔记' };
    }

    // 生成批次 id + 元信息（下载管理页按 batchId 聚合成一行展示）
    const batchId = 'xhsbatch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const batchInfo = {
      batchId,
      platform: 'xiaohongshu',
      nickname: userInfo.nickname || (notes[0] && notes[0].author && notes[0].author.name) || '小红书用户',
      avatar: userInfo.avatar || (notes[0] && notes[0].author && notes[0].author.avatar) || '',
      profileUrl,
      totalCount: notes.length,
      createTime: Date.now(),
    };

    // 1. 为每条笔记创建下载任务：
    //    - 视频笔记：直接创建 yt-dlp 任务入队（yt-dlp 带登录 cookie 解析笔记页并下载；
    //      失败自动回退隐藏窗口 feed 解析，见 startXhsFeedFallback）
    //    - 图集/未知类型：yt-dlp 无法下载图集，走 parsing 占位 + 后台 feed 解析（原链路）
    const resolveItems = []; // 传给后台 feed 解析的 {noteId, xsecToken, taskId}
    const ytdlTasks = [];    // 直接入队的 yt-dlp 视频任务
    const newTaskIds = [];
    for (const n of notes) {
      const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      const videoInfo = {
        title: n.title || n.noteId,
        author: (n.author && n.author.name) || batchInfo.nickname,
        platform: 'xiaohongshu',
        platformName: '小红书',
        cover: n.cover || '',
        sourceUrl: `https://www.xiaohongshu.com/explore/${n.noteId}`,
        // xsec_token 持久化：任务失败后重试重新解析需要它（xhsNote 不落 DB，
        // 重启丢失；写进 videoInfo 随 download_tasks 落盘，重试时从 DB 恢复）
        xsecToken: (n && n.xsecToken) || '',
      };
      const baseTask = {
        id: taskId,
        videoInfo,
        platform: 'xiaohongshu',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        startTime: Date.now(),
        xhsNote: { noteId: n.noteId, xsecToken: n.xsecToken || '' },
        batchId,                 // 同批任务共享，下载管理页据此分组
        batchInfo,               // 分组展示用的元信息（用户名/主页链接/头像/总数）
      };
      if (n.type === 'video' && n.noteId) {
        // 视频笔记：yt-dlp 优先。保持与 feed 链路一致的目录结构（作者/笔记标题/笔记标题.mp4）
        const noteFolder = safeXhsName(n.title || n.noteId);
        const noteDir = path.join(getXhsCustomDir(videoInfo), noteFolder);
        try { fs.mkdirSync(noteDir, { recursive: true }); } catch (e) {}
        const task = {
          ...baseTask,
          filename: noteFolder + '.mp4',
          url: 'ytdl-data',        // 标记为 yt-dlp 任务
          savePath: path.join(noteDir, noteFolder + '.mp4'),
          customDir: noteDir,
          status: 'pending',
          type: 'ytdl',
          ytdlUrl: buildXhsExploreUrl(n.noteId, n.xsecToken || ''),
          ytdlMaxHeight: 0,
        };
        downloadTasks.push(task);
        ytdlTasks.push(task);
      } else {
        const task = {
          ...baseTask,
          filename: n.title || n.noteId,
          url: 'xhs-note',        // 占位标记，解析后替换为真实下载地址
          savePath: '',            // 解析后填充
          status: 'parsing',       // 解析中
          type: 'xhs-note',        // 解析完会改写为 '' 或 'album'
        };
        downloadTasks.push(task);
        resolveItems.push({ noteId: n.noteId, xsecToken: n.xsecToken || '', taskId });
      }
      newTaskIds.push(taskId);
    }

    saveDownloadTasks();

    // 2. 广播所有新任务（下载管理页立即显示"等待中/解析中"）
    if (mainWindow && mainWindow.webContents) {
      for (const id of newTaskIds) {
        const task = downloadTasks.find(x => x.id === id);
        if (task) mainWindow.webContents.send('download-task-added', task);
      }
    }

    // 3. 视频任务立即入队（有界调度器并发拉取，yt-dlp 下载失败自动回退 feed）
    for (const task of ytdlTasks) enqueueDownload(task);

    // 4. 图集/未知类型笔记后台批量 feed 解析（不 await，立即返回给前端）
    if (resolveItems.length > 0) {
      resolveXhsNotesBatch(resolveItems).catch(err => {
        console.error('[XhsProfile] 后台批量解析异常:', err.message);
      });
    }

    return { success: true, count: notes.length };
  } catch (error) {
    console.error('[XhsProfile] 批量下载提交失败:', error.message);
    return { success: false, error: error.message };
  }
});

/**
 * 后台批量解析小红书笔记详情，解析完一条就立即把该任务转为真实下载任务（边解析边下载）。
 *
 * 流程：fetchNoteDetailBatch 并发解析(3路)，每条解析完成立即回调 handleResolved：
 *   - 解析失败：task 标记 failed
 *   - 视频：改写 task.url/filename/savePath/status=pending/type='' 后入调度器
 *   - 图集：改写 task.albumItems/filename/savePath/status=pending/type='album' 后入调度器
 *   - 无法识别：task 标记 failed
 * 每条处理完都保存任务并通过调度器触发下载。
 * 因此下载不用等全部解析完：第一批解析完（3 条）就开始下载，边解析边下载队列滚动前进。
 * 全部解析完成后销毁隐藏窗口释放资源。
 */
async function resolveXhsNotesBatch(resolveItems) {
  console.log('[XhsProfile] 开始后台批量解析，共', resolveItems.length, '条');

  // 单条解析结果 -> 转为真实下载任务（同步逻辑，每条解析完立即执行）
  const handleResolved = (r, item) => {
    try {
      const task = downloadTasks.find(t => t.id === item.taskId);
      if (!task) {
        console.warn('[XhsProfile] 任务已不存在:', item.taskId);
        return;
      }

      // 解析失败
      if (!r.ok) {
        task.status = 'failed';
        task.error = '解析失败: ' + (r.error || '未知错误');
        task.endTime = Date.now();
        saveDownloadTasks();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
        }
        return;
      }

      // 解析成功：用 parseNoteCard 转统一结构，再改写 task 为真实下载任务
      let data;
      try {
        data = parseNoteCard(r.noteCard);
      } catch (e) {
        task.status = 'failed';
        task.error = '数据解析失败: ' + e.message;
        task.endTime = Date.now();
        saveDownloadTasks();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
        }
        return;
      }

      // 更新 videoInfo（解析后可能有更准确的 title/author/cover）
      task.videoInfo = {
        ...task.videoInfo,
        title: data.title || task.videoInfo.title,
        cover: data.cover || task.videoInfo.cover,
        author: (data.author && data.author.name) || task.videoInfo.author,
      };

      if (data.type === 'video' && data.video && data.video.url) {
        // 视频：每条作品独立文件夹（作品标题/作品标题.mp4）
        const noteFolder = safeXhsName(data.title);
        const workDir = path.join(getXhsCustomDir(task.videoInfo), noteFolder);
        try { fs.mkdirSync(workDir, { recursive: true }); } catch (e) {}
        task.url = data.video.url;
        task.filename = noteFolder + '.mp4';
        task.savePath = path.join(workDir, task.filename);
        task.status = 'pending';
        task.type = '';  // 普通视频下载（executeDownload 默认分支）
        console.log('[XhsProfile] 解析为视频:', task.savePath);
      } else if (data.type === 'image' && data.images && data.images.length > 0) {
        // 图集：每条作品独立文件夹（作品标题/图片们）
        task.albumItems = data.images.map(img => {
          const list = [];
          if (img.url) list.push({ url: img.url, type: 'image', ext: '.jpg' });
          if (img.livePhotoUrl) list.push({ url: img.livePhotoUrl, type: 'video', ext: '.mp4' });
          return list;
        }).flat();
        const noteFolder = safeXhsName(data.title);
        task.filename = noteFolder + '（' + task.albumItems.length + '张）';
        // 告知 executeAlbumDownload 用这个专属目录（小红书主页固定 小红书/主页/作者/ 三层）
        task.customDir = getXhsCustomDir(task.videoInfo);
        task.albumFolderName = noteFolder;  // 图集文件夹名=作品标题（不加随机后缀，因已在作者目录下）
        task.savePath = '';  // executeAlbumDownload 内部根据 customDir + albumFolderName 设置 albumDir
        task.totalBytes = task.albumItems.length;
        task.albumIndex = 0;
        task.albumDir = '';
        task.status = 'pending';
        task.type = 'album';
        console.log('[XhsProfile] 解析为图集:', task.filename, task.albumItems.length, '张');
      } else {
        // 无法识别下载地址
        task.status = 'failed';
        task.error = '无法解析下载地址（可能笔记已被删除或为非视频/图集类型）';
        task.endTime = Date.now();
        saveDownloadTasks();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-failed', { id: task.id, error: task.error });
        }
        return;
      }

      // 清理解析专用字段
      delete task.xhsNote;
      if (!enqueueXhsTask(task)) return;

      // 通知前端状态从 parsing 变为 pending（触发列表刷新显示）
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-progress', { id: task.id, progress: 0, receivedBytes: 0, totalBytes: task.totalBytes });
      }
      // 每解析完一条就交给有界调度器，无需等全部解析完
    } catch (e) {
      console.error('[XhsProfile] 处理单条解析结果异常:', e.message);
    }
  };

  await xhsProfile.fetchNoteDetailBatch(resolveItems, (done, total) => {
    console.log(`[XhsProfile] 解析进度 ${done}/${total}`);
  }, (r, item) => {
    // 流式：每条解析完立即转下载任务
    handleResolved(r, item);
  });

  console.log('[XhsProfile] 批量解析完成');
  // 全部解析完，销毁隐藏窗口释放内存
  try { xhsProfile.destroy(); } catch (e) {}
}

// ===== 批量添加账号 IPC =====
// items: 字符串数组（每条是主页链接或 sec_user_id）
// groupId: 目标分组 id（null/空 = 未分组）
// 串行处理，每条间隔 300ms，避免被限流；单条失败不中断
ipcMain.handle('account-add-batch', async (event, { items, groupId }) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, error: '没有输入任何链接' };
  }
  const results = [];
  const existingAccounts = db.listAccounts();
  const existingIds = new Set(existingAccounts.map(a => a.sec_user_id));
  const gid = groupId || null;

  for (let i = 0; i < items.length; i++) {
    const raw = String(items[i] || '').trim();
    if (!raw) {
      results.push({ index: i, input: raw, success: false, error: '空行' });
      continue;
    }

    // 1) 解析 sec_user_id
    let secUserId = null;
    try {
      if (raw.includes('douyin.com') || raw.includes('v.douyin.com')) {
        const directMatch = raw.match(/user\/([^?&/]+)/);
        if (directMatch) {
          secUserId = directMatch[1];
        } else {
          const resolved = await douyinAPI.resolveShareLink(raw);
          if (resolved && typeof resolved === 'string') {
            const m = resolved.match(/user\/([^?&/]+)/);
            if (m) secUserId = m[1];
          }
        }
      } else {
        secUserId = raw;
      }
    } catch (err) {
      results.push({ index: i, input: raw, success: false, error: '链接解析失败: ' + err.message });
      if (i < items.length - 1) await sleep(300);
      continue;
    }

    if (!secUserId) {
      results.push({ index: i, input: raw, success: false, error: '无法提取用户ID' });
      if (i < items.length - 1) await sleep(300);
      continue;
    }

    // 2) 查重
    if (existingIds.has(secUserId)) {
      results.push({ index: i, input: raw, success: false, skipped: true, secUserId, error: '已存在' });
      if (i < items.length - 1) await sleep(300);
      continue;
    }

    // 3) 获取用户资料
    try {
      const profileData = await douyinAPI.getUserProfile(secUserId);
      if (!profileData || !profileData.user) {
        results.push({ index: i, input: raw, success: false, secUserId, error: '获取用户信息失败' });
        if (i < items.length - 1) await sleep(300);
        continue;
      }
      const u = profileData.user;
      const accountData = {
        sec_user_id: secUserId,
        nickname: u.nickname || '未知用户',
        unique_id: u.unique_id || u.short_id || '',
        avatar: u.avatar_thumb?.url_list?.[0] || '',
        signature: u.signature || '',
        follower_count: u.follower_count || 0,
        following_count: u.following_count || 0,
        total_favorited: u.total_favorited || 0,
        aweme_count: u.aweme_count || 0,
        favoriting_count: u.favoriting_count || 0,
        added_time: Date.now(),
        group_id: gid,
      };

      // 4) 写库
      db.addAccount(accountData);
      db.pushAccountSnapshot(secUserId, {
        follower_count: accountData.follower_count,
        following_count: accountData.following_count,
        total_favorited: accountData.total_favorited,
        aweme_count: accountData.aweme_count,
        favoriting_count: accountData.favoriting_count,
      });
      existingIds.add(secUserId);
      results.push({ index: i, input: raw, success: true, secUserId, nickname: accountData.nickname });

      // 5) 后台异步拉作品（不阻塞批量流程，失败不影响结果）
      checkAccount(accountData).catch(e => {
        console.warn('[Account] 批量添加初始同步失败:', secUserId, e.message);
      });
    } catch (err) {
      results.push({ index: i, input: raw, success: false, secUserId, error: err.message || '添加失败' });
    }

    if (i < items.length - 1) await sleep(300);
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success && !r.skipped).length;
  const skipCount = results.filter(r => r.skipped).length;
  console.log(`[Account] 批量添加完成: 成功${successCount} 失败${failCount} 跳过${skipCount} 共${items.length}`);

  return {
    success: true,
    results,
    summary: { total: items.length, success: successCount, fail: failCount, skip: skipCount },
    accounts: db.listAccounts(),
  };
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 刷新账号信息（包含个人资料、作品清单、时序历史）
ipcMain.handle('account-refresh', async (event, { secUserId, patch }) => {
  try {
    if (patch) {
      db.updateAccount(secUserId, patch);
      db.pushAccountSnapshot(secUserId, {
        follower_count: patch.follower_count,
        following_count: patch.following_count,
        total_favorited: patch.total_favorited,
        aweme_count: patch.aweme_count,
        favoriting_count: patch.favoriting_count,
      });
    }

    // 后台执行一次 checkAccount 抓取最新数据
    const accounts = db.listAccounts();
    const acc = accounts.find(a => a.sec_user_id === secUserId);
    if (acc) {
      await checkAccount(acc);
    }
    return { success: true, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Account] 刷新失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 一次性迁移 localStorage 中的 saved_accounts 到 DB（仅迁移一次）
ipcMain.handle('account-migrate-localStorage', async (event, accounts) => {
  try {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { success: true, migrated: 0, migratedIds: [], accounts: db.listAccounts() };
    }
    let migrated = 0;
    const migratedIds = [];
    for (const acc of accounts) {
      if (acc && acc.sec_user_id) {
        db.addAccount(acc);
        migrated++;
        migratedIds.push(String(acc.sec_user_id));
      }
    }
    return { success: true, migrated, migratedIds, accounts: db.listAccounts() };
  } catch (error) {
    console.error('[Account] 迁移失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 读取账号增速历史（粉丝/获赞/作品数等时序）
ipcMain.handle('account-get-history', async (event, secUserId) => {
  try {
    return { success: true, history: db.listAccountHistory(secUserId) };
  } catch (error) {
    console.error('[Account] 读取历史失败:', error.message);
    return { success: false, error: error.message, history: [] };
  }
});

// 读取账号下当前作品清单（含最新快照统计）
ipcMain.handle('account-get-works', async (event, secUserId) => {
  try {
    return { success: true, works: db.listAccountWorks(secUserId) };
  } catch (error) {
    console.error('[Account] 读取作品失败:', error.message);
    return { success: false, error: error.message, works: [] };
  }
});

// 读取单个作品的统计时序（点赞/评论随时间）
ipcMain.handle('account-get-work-stats', async (event, awemeId) => {
  try {
    return { success: true, history: db.listWorkStatsHistory(awemeId) };
  } catch (error) {
    console.error('[Account] 读取作品时序失败:', error.message);
    return { success: false, error: error.message, history: [] };
  }
});

// 立即触发一次账号检查（不等待周期）
ipcMain.handle('account-check-now', async () => {
  if (monitorRunning) return { success: false, error: '正在检查中，请稍候' };
  // 设置标志位，避免与监控周期 runMonitorCycle 并发跑（两者都会请求抖音接口并写 DB）
  monitorRunning = true;
  try {
    const accounts = db.listAccounts();
    for (const acc of accounts) {
      try {
        await checkAccount(acc);
      } catch (e) {
        console.error('[Account] 立即检查失败:', acc.sec_user_id, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    db.flushNow();
    emitAccountUpdated();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    monitorRunning = false;
  }
});

// ===== 监控 IPC =====

ipcMain.handle('monitor-add-user', async (event, inputOrObj) => {
  try {
    // 兼容旧调用：字符串 input；新调用：{input, groupId}
    const input = typeof inputOrObj === 'string' ? inputOrObj : (inputOrObj && inputOrObj.input) || '';
    const groupId = typeof inputOrObj === 'object' && inputOrObj ? (inputOrObj.groupId || null) : null;
    const secUserId = await resolveSecUserId(input);
    if (!secUserId) return { success: false, error: '无法识别用户，请检查链接或ID' };
    if (monitorUsers.some(u => u.secUserId === secUserId)) {
      return { success: false, error: '该用户已在监控列表中' };
    }

    const profile = await douyinAPI.getUserProfile(secUserId);
    const u = profile && profile.user;
    if (!u) return { success: false, error: '获取用户信息失败，请确认已登录' };

    // 设置基线：记录当前最新作品时间，避免首次添加报旧视频
    const videos = await fetchFirstPageVideos(secUserId);
    const lastAwemeTime = videos.length ? Math.max(...videos.map(v => v.create_time || 0)) : 0;
    // lastAwemeId 取 create_time 最大的那条（列表不一定按时间倒序）
    const lastVideo = videos.length
      ? videos.reduce((a, b) => ((b.create_time || 0) > (a.create_time || 0) ? b : a), videos[0])
      : null;

    const initFollower = extractFollowerCount(u) ?? 0;
    const user = {
      secUserId,
      nickname: u.nickname || '未知用户',
      avatar: u.avatar_thumb?.url_list?.[0] || '',
      uniqueId: u.unique_id || u.short_id || '',
      followerCount: initFollower,
      followerHistory: [{ time: Date.now(), value: initFollower }],
      awemeCount: typeof u.aweme_count === 'number' ? u.aweme_count : 0,
      lastAwemeTime,
      lastAwemeId: lastVideo?.aweme_id || '',
      notifyFollower: true,
      notifyNewVideo: true,
      addedAt: Date.now(),
      lastChecked: Date.now(),
      groupId,
      remark: '',
      tags: [],
      pinned: false,
    };
    monitorUsers.push(user);
    db.addMonitorUser(user);
    emitMonitorUpdated();
    return { success: true, user };
  } catch (error) {
    console.error('[Monitor] 添加用户失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('monitor-remove-user', async (event, secUserId) => {
  monitorUsers = monitorUsers.filter(u => u.secUserId !== secUserId);
  db.removeMonitorUser(secUserId);
  emitMonitorUpdated();
  return { success: true };
});

ipcMain.handle('monitor-update-user', async (event, { secUserId, notifyFollower, notifyNewVideo }) => {
  const user = monitorUsers.find(u => u.secUserId === secUserId);
  if (user) {
    if (typeof notifyFollower === 'boolean') user.notifyFollower = notifyFollower;
    if (typeof notifyNewVideo === 'boolean') user.notifyNewVideo = notifyNewVideo;
    db.updateMonitorUser(secUserId, { notifyFollower: user.notifyFollower, notifyNewVideo: user.notifyNewVideo });
    emitMonitorUpdated();
  }
  return { success: true };
});

ipcMain.handle('monitor-list-users', async () => monitorUsers);

ipcMain.handle('monitor-add-video', async (event, inputOrObj) => {
  try {
    // 兼容旧调用：字符串 input；新调用：{input, groupId}
    const input = typeof inputOrObj === 'string' ? inputOrObj : (inputOrObj && inputOrObj.input) || '';
    const groupId = typeof inputOrObj === 'object' && inputOrObj ? (inputOrObj.groupId || null) : null;
    const awemeId = await resolveAwemeId(input);
    if (!awemeId) return { success: false, error: '无法识别视频，请检查链接或ID' };
    if (monitorVideos.some(v => v.awemeId === awemeId)) {
      return { success: false, error: '该视频已在监控列表中' };
    }

    const detail = await douyinAPI.getVideoDetail(awemeId);
    const d = detail && (detail.aweme_detail || detail);
    if (!d || !d.statistics) return { success: false, error: '获取视频信息失败，请确认已登录' };

    const initDigg = d.statistics.digg_count ?? 0;
    const initComment = d.statistics.comment_count ?? 0;
    const video = {
      awemeId,
      desc: d.desc || '无标题',
      author: d.author?.nickname || '',
      cover: d.video?.cover?.url_list?.[0] || '',
      diggCount: initDigg,
      commentCount: initComment,
      statsHistory: [{ time: Date.now(), diggCount: initDigg, commentCount: initComment }],
      addedAt: Date.now(),
      lastChecked: Date.now(),
      groupId,
      remark: '',
      tags: [],
      pinned: false,
    };
    monitorVideos.push(video);
    db.addMonitorVideo(video);
    emitMonitorUpdated();
    return { success: true, video };
  } catch (error) {
    console.error('[Monitor] 添加视频失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('monitor-remove-video', async (event, awemeId) => {
  monitorVideos = monitorVideos.filter(v => v.awemeId !== awemeId);
  db.removeMonitorVideo(awemeId);
  emitMonitorUpdated();
  return { success: true };
});

ipcMain.handle('monitor-list-videos', async () => monitorVideos);

ipcMain.handle('monitor-get-events', async () => monitorEvents);

ipcMain.handle('monitor-clear-events', async () => {
  monitorEvents = [];
  db.clearMonitorEvents();
  return { success: true };
});

ipcMain.handle('monitor-mark-events-read', async () => {
  monitorEvents = monitorEvents.map(e => ({ ...e, read: true }));
  db.markMonitorEventsRead();
  return { success: true };
});

ipcMain.handle('monitor-get-config', async () => monitorConfig);

ipcMain.handle('monitor-set-config', async (event, config) => {
  monitorConfig = { ...monitorConfig, ...(config || {}) };
  saveMonitorConfig();
  startMonitor(); // 重新应用间隔/开关
  return { success: true, config: monitorConfig };
});

// 测试 Server酱 推送：用传入的 sctkey（无需先保存即可测试）
ipcMain.handle('test-server-chan', async (event, payload) => {
  const sctkey = payload && payload.sctkey;
  if (!sctkey) return { success: false, error: '请先填写 SendKey' };
  try {
    const r = await axios.post(`https://sctapi.ftqq.com/${sctkey}.send`,
      { title: '抖音监控测试', desp: '这是一条来自抖音-TikTok 多平台的测试推送。如果你收到了，说明 Server酱 配置成功！' },
      { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
    // Server酱返回 { code, message, data: {pushid, readkey, ...} }
    if (r && r.data && (r.data.code === 0 || r.data.code === '0')) {
      return { success: true };
    }
    return { success: false, error: (r && r.data && r.data.message) || '推送返回异常' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 立即检查一次
ipcMain.handle('monitor-check-now', async () => {
  if (monitorRunning) return { success: false, error: '正在检查中，请稍候' };
  runMonitorCycle();
  return { success: true };
});

// ===== 抖音搜索下载（纯逆向：签名捕获 + net.fetch 纯 HTTP 翻页） =====// 逆向结论（实测验证）：
//   1. 抖音搜索接口对 Node/axios 直连（OpenSSL TLS 指纹）风控极严，返回 verify_check；
//      但 Electron net 模块（Chromium 网络栈）请求同一接口正常。
//   2. a_bogus 签名由页面 SDK（webmssdk）生成，可跨参数复用——换关键词/换 offset 均返回数据。
//   3. 搜索响应 data[i].aweme_info 即完整 aweme（含视频直链），无需再调详情接口。
// 因此：首次搜索用隐藏窗口打开搜索页，从网络请求里捕获一次真实签名 URL 作为模板，
//       之后的翻页/换词全部 net.fetch 纯 HTTP 完成（零浏览器自动化取数）。

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

let searchWindow = null;
let searchSignatureUrl = null; // 捕获到的真实搜索 URL 模板（含页面 SDK 生成的 a_bogus），整个会话复用

function getSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) return searchWindow;
  // 完全无窗口（show:false）：页面作为签名提供者，绝不显示浏览器。
  // paintWhenInitiallyHidden + backgroundThrottling(false) 保证隐藏时页面照常渲染/发请求（已实测翻页正常）。
  searchWindow = new BrowserWindow({
    show: false,
    x: -99999,
    y: -99999,
    width: 1200,
    height: 900,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      partition: 'persist:douyin',
      contextIsolation: true,
      nodeIntegration: false,
      paintWhenInitiallyHidden: true,
    },
  });
  searchWindow.webContents.setBackgroundThrottling(false);
  guardExternalNavigation(searchWindow.webContents);
  searchWindow.on('closed', () => { searchWindow = null; });
  return searchWindow;
}

// 打开搜索页，从网络请求捕获真实搜索 URL（含 SDK 生成的 a_bogus）；15 秒超时
function captureSearchSignature(keyword) {
  return new Promise((resolve) => {
    const ses = session.fromPartition('persist:douyin');
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try { ses.webRequest.onBeforeSendHeaders(null); } catch (e) { /* ignore */ }
    };
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = details.url || '';
      if (!settled && /aweme\/v1\/web\/general\/search\/single\//.test(url) && url.includes('a_bogus=')) {
        searchSignatureUrl = url;
        cleanup();
        resolve(url);
      }
      callback({});
    });
    const win = getSearchWindow();
    win.loadURL(`https://www.douyin.com/search/${encodeURIComponent(keyword)}`).catch(() => {});
    setTimeout(() => { cleanup(); resolve(null); }, 15000);
  });
}

// 替换 URL 中的查询参数值
function setUrlParam(url, name, value) {
  const re = new RegExp('([?&])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^&]*');
  return url.replace(re, (m, sep) => `${sep}${name}=${encodeURIComponent(value)}`);
}

ipcMain.handle('douyin-search', async (event, keyword, maxPages = 10) => {
  const kw = String(keyword || '').trim();
  if (!kw) return { success: false, error: '请输入搜索关键词' };
  try {
    // 1. 首次搜索：捕获真实签名 URL（后续搜索复用）
    if (!searchSignatureUrl) {
      const sig = await captureSearchSignature(kw);
      if (!sig) return { success: false, error: '签名获取失败，请检查网络或重新登录抖音后重试' };
    }

    // 2. 纯 HTTP 翻页（签名已捕获，换词/翻页均复用）
    const pageCount = Math.min(Math.max(Number(maxPages) || 10, 1), 999);
    const allAwemes = [];
    const seenIds = new Set();
    let offset = 0;

    for (let page = 0; page < pageCount; page++) {
      // 逐页推送进度给前端（搜索进度条 / 按钮文案）
      try {
        event.sender.send('douyin-search-progress', {
          page: page + 1,
          total: pageCount,
          fetched: allAwemes.length,
          keyword: kw,
        });
      } catch (e) { /* ignore */ }

      let url = setUrlParam(searchSignatureUrl, 'keyword', kw);
      url = setUrlParam(url, 'offset', String(offset));
      // 用 persist:douyin 分区的 net.fetch：自动携带该分区 cookie（登录态），Chromium 指纹正常
      const res = await session.fromPartition('persist:douyin').fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': SEARCH_UA,
          'Referer': `https://www.douyin.com/search/${encodeURIComponent(kw)}`,
        },
      });
      const json = await res.json().catch(() => null);
      if (!json || json.status_code !== 0) break;
      const list = Array.isArray(json.data) ? json.data : [];
      let addedThisPage = 0;
      for (const item of list) {
        // 只收明确的 aweme 结构（搜索卡片里混有用户卡/话题卡等，不带 aweme 直接跳过）
        const aw = item && (item.aweme_info || item.aweme);
        const id = aw && aw.aweme_id;
        if (!id || seenIds.has(String(id))) continue;
        seenIds.add(String(id));
        allAwemes.push(aw);
        addedThisPage++;
      }
      if (addedThisPage === 0) break; // 无新数据，停止
      const next = Number(json.cursor) || Number(json.offset) || 0;
      offset = next > offset ? next : offset + list.length;
      if (!json.has_more) break;
      // 每页间隔，避免触发风控
      await new Promise((r) => setTimeout(r, 300));
    }

    return { success: true, videos: allAwemes };
  } catch (error) {
    console.error('[Search] 搜索失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== YouTube 频道 Shorts 抓取（纯 HTTP 逆向，无浏览器） =====
ipcMain.handle('youtube-shorts', async (event, url, maxPages = 20) => {
  try {
    const res = await fetchChannelShorts(url, (progress) => {
      // 逐页推送进度给前端（youtube-shorts-progress）
      try {
        event.sender.send('youtube-shorts-progress', progress);
      } catch (e) { /* ignore */ }
    }, maxPages);
    return res;
  } catch (error) {
    console.error('[YouTubeShorts] 抓取失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 抖音用户喜欢列表（纯逆向：隐藏窗口滚动捕获签名 + net.fetch 纯 HTTP 重放） =====
// favorite 接口对脚本直连风控严，且签名与参数强绑定（改 cursor 即失效）。
// 方案：隐藏窗口打开用户喜欢页，滚动触发页面自动翻页（每页由页面 SDK 生成有效签名），
//       webRequest 捕获每一页的 favorite URL，再逐页用 net.fetch 纯 HTTP 重放取数。

let likedWindow = null;

function getLikedWindow() {
  if (likedWindow && !likedWindow.isDestroyed()) return likedWindow;
  // 完全无窗口（show:false），绝不显示浏览器；paintWhenInitiallyHidden 保证隐藏时页面照常渲染/发请求
  likedWindow = new BrowserWindow({
    show: false,
    x: -99999, y: -99999, width: 1280, height: 900,
    skipTaskbar: true, focusable: false,
    webPreferences: { partition: 'persist:douyin', contextIsolation: true, nodeIntegration: false, paintWhenInitiallyHidden: true },
  });
  likedWindow.webContents.setBackgroundThrottling(false);
  guardExternalNavigation(likedWindow.webContents);
  likedWindow.on('closed', () => { likedWindow = null; });
  return likedWindow;
}

ipcMain.handle('douyin-liked', async (event, url, maxPages = 20) => {
  try {
    const rawUrl = String(url || '').trim();
    const m = rawUrl.match(/user\/([^?&/]+)/);
    if (!m) return { success: false, error: '无法从链接中提取用户ID' };

    // 关键：网页端喜欢页必须带 showTab=like 才会请求对方喜欢的 favorite 接口；
    // 用户只填主页链接（无 showTab）时自动补上，否则页面停在作品 tab，捕获不到喜欢请求。
    let targetUrl = rawUrl;
    try {
      const u = new URL(rawUrl);
      if (/douyin\.com/i.test(u.hostname) && !u.searchParams.has('showTab')) {
        u.searchParams.set('showTab', 'like');
        targetUrl = u.toString();
      }
    } catch (e) { /* 非法 URL 保持原样 */ }

    // self = 自己的喜欢（我的喜欢），不做"未公开"检测；别人的主页检测对方是否公开了喜欢列表
    const targetUid = m[1] === 'self' ? null : decodeURIComponent(m[1]);
    const win = getLikedWindow();
    const ses = session.fromPartition('persist:douyin');

    // 1. 捕获每一页 favorite 请求 URL（按 max_cursor 去重，各页自带有效签名）
    //    同时保存请求头的 uifid（设备指纹头）：部分接口重放缺它会被网关 444 拒绝
    const favUrls = []; // { url, uifid }
    const handler = (details, callback) => {
      const u = details.url || '';
      if (/aweme\/favorite\//.test(u) && u.includes('a_bogus=')) {
        const mc = (u.match(/max_cursor=([^&]+)/) || [])[1];
        if (!favUrls.some((x) => (x.url.match(/max_cursor=([^&]+)/) || [])[1] === mc)) {
          favUrls.push({ url: u, uifid: (details.requestHeaders && details.requestHeaders['uifid']) || '' });
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    };
    ses.webRequest.onBeforeSendHeaders(handler);

    // 2. 打开喜欢页并滚动触发翻页（最多 maxPages 次滚动），滚动阶段也逐页推送进度
    win.loadURL(targetUrl).catch(() => {});
    try {
      event.sender.send('douyin-liked-progress', { stage: 'load', message: '正在打开喜欢页...' });
    } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 9000));
    const pageLimit = Math.min(Math.max(Number(maxPages) || 20, 1), 100);
    let lastGain = favUrls.length;
    let noGain = 0;
    for (let i = 1; i <= pageLimit; i++) {
      await new Promise((r) => setTimeout(r, 1400));
      try {
        await win.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.parent-route-container') || document.querySelector('.route-scroll-container') || document.documentElement; el.scrollTop = ${i * 1500}; return 'ok'; })()`
        );
      } catch (e) { /* ignore */ }
      if (favUrls.length === lastGain) noGain++; else { lastGain = favUrls.length; noGain = 0; }
      try {
        event.sender.send('douyin-liked-progress', { stage: 'scroll', page: i, total: pageLimit, fetched: favUrls.length });
      } catch (e) { /* ignore */ }
      if (noGain >= 3 && i >= 4) break; // 连续 3 次无新分页且至少滚了 4 次 → 数据已到底
    }
    await new Promise((r) => setTimeout(r, 2000));
    try { ses.webRequest.onBeforeSendHeaders(null); } catch (e) { /* ignore */ }

    // 未公开检测：别人的主页若喜欢未公开，页面会跳回当前登录账号自己的主页，
    // 捕获到的 favorite 请求带的是自己的 sec_user_id（与目标不一致）→ 直接提示。
    if (targetUid) {
      const capturedSuids = favUrls
        .map((u) => (u.url.match(/sec_user_id=([^&]+)/) || [])[1])
        .filter(Boolean)
        .map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
      if (capturedSuids.length > 0 && !capturedSuids.some((s) => s === targetUid)) {
        return { success: false, error: '该用户未公开喜欢列表，无法获取（网页端只能获取公开了喜欢的用户，或你自己的喜欢）' };
      }
    }
    if (favUrls.length === 0) {
      return { success: false, error: '未能捕获到喜欢列表请求，请确认该用户公开了喜欢列表，或稍后重试' };
    }

    // 3. 逐页 net.fetch 纯 HTTP 重放取数（每页自己的签名），推送进度
    const allAwemes = [];
    const seenIds = new Set();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
    for (let i = 0; i < favUrls.length; i++) {
      try {
        event.sender.send('douyin-liked-progress', { stage: 'fetch', page: i + 1, total: favUrls.length, fetched: allAwemes.length });
        const uifid = (favUrls[i] && favUrls[i].uifid) || '';
        const headers = {
          'User-Agent': UA,
          'Referer': targetUrl,
          'Accept': 'application/json, text/plain, */*',
          ...(uifid ? { 'uifid': uifid } : {}),
        };
        const res = await ses.fetch(favUrls[i].url, { method: 'GET', headers });
        const j = await res.json().catch(() => null);
        const list = (j && Array.isArray(j.aweme_list)) ? j.aweme_list : (j && j.data && Array.isArray(j.data.aweme_list) ? j.data.aweme_list : []);
        for (const aw of list) {
          const id = aw && aw.aweme_id;
          if (!id || seenIds.has(String(id))) continue;
          seenIds.add(String(id));
          allAwemes.push(aw);
        }
      } catch (e) { /* 单页失败跳过 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      event.sender.send('douyin-liked-progress', { stage: 'fetch', page: favUrls.length, total: favUrls.length, fetched: allAwemes.length });
    } catch (e) { /* ignore */ }

    return { success: true, videos: allAwemes };
  } catch (error) {
    console.error('[Liked] 获取喜欢列表失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 我的账号：user/self 页各 tab 数据下载（纯逆向） =====
// 与 douyin-liked 同模式：隐藏窗口打开 user/self?showTab=xxx，滚动触发页面 SDK 生成签名，
// webRequest 捕获各页接口 URL，net.fetch 重放取数。
// 已实测确认各 tab 的真实接口（收藏为 POST 请求，需按 cursor 翻页）：
const SELF_TAB_CONFIG = {
  post:        { label: '我的发布', showTab: 'post',                path: /\/aweme\/v1\/web\/aweme\/post\//,               method: 'GET',  listKey: 'aweme_list' },
  recommend:   { label: '推荐',     showTab: 'recommend',           path: /familiar\/recommend\/feed\//,                  method: 'GET',  listKey: 'aweme_list' },
  like:        { label: '喜欢',     showTab: 'like',                path: /\/aweme\/v1\/web\/aweme\/favorite\//,          method: 'GET',  listKey: 'aweme_list' },
  favorite:    { label: '收藏',     showTab: 'favorite_collection', path: /\/aweme\/v1\/web\/aweme\/listcollection\//,    method: 'POST', listKey: 'aweme_list' },
  history:     { label: '观看历史', showTab: 'record',              path: /\/aweme\/v1\/web\/history\/read\//,            method: 'GET',  listKey: 'aweme_list' },
  watch_later: { label: '稍后再看', showTab: 'watch_later',         path: /\/aweme\/v1\/web\/watchlater\/list\//,         method: 'GET',  listKey: 'items' },
};

let selfWin = null;

function getSelfWindow() {
  if (selfWin && !selfWin.isDestroyed()) return selfWin;
  // 完全无窗口（show:false），绝不显示浏览器；paintWhenInitiallyHidden 保证隐藏时页面照常渲染/发请求
  selfWin = new BrowserWindow({
    show: false,
    x: -99999, y: -99999, width: 1280, height: 900,
    skipTaskbar: true, focusable: false,
    webPreferences: { partition: 'persist:douyin', contextIsolation: true, nodeIntegration: false, paintWhenInitiallyHidden: true },
  });
  selfWin.webContents.setBackgroundThrottling(false);
  selfWin.on('closed', () => { selfWin = null; });
  return selfWin;
}

ipcMain.handle('douyin-self-fetch', async (event, tab, maxPages = 20) => {
  try {
    const cfg = SELF_TAB_CONFIG[tab];
    if (!cfg) return { success: false, error: '未知的账号数据类别' };
    const win = getSelfWindow();
    const ses = session.fromPartition('persist:douyin');
    const targetUrl = `https://www.douyin.com/user/self?from_tab_name=main&showTab=${cfg.showTab}`;

    // 1. 捕获该 tab 数据接口的请求 URL（POST 接口无 a_bogus，按完整 URL 去重）
    //    同时保存页面请求头的 uifid（设备指纹头）——recommend/watch_later 等接口重放时
    //    缺这个头会被网关 444 Access Denied 拒绝（已实测：带上 uifid 后 200 正常返回）
    const favUrls = []; // { url, uifid }
    const handler = (details, callback) => {
      const u = details.url || '';
      if (cfg.path.test(u) && (cfg.method === 'POST' || u.includes('a_bogus='))) {
        if (!favUrls.some((x) => x.url === u)) {
          favUrls.push({ url: u, uifid: (details.requestHeaders && details.requestHeaders['uifid']) || '' });
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    };
    ses.webRequest.onBeforeSendHeaders(handler);

    // 2. 打开 self 页对应 tab 并滚动触发翻页（每页由页面 SDK 生成有效签名）
    //    数据到底后（连续 3 次滚动没捕获到新分页请求）提前结束，避免无意义的空转
    win.loadURL(targetUrl).catch(() => {});
    try {
      event.sender.send('douyin-self-progress', { stage: 'load', message: '正在打开我的账号页...' });
    } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 9000));
    const pageLimit = Math.min(Math.max(Number(maxPages) || 20, 1), 100);
    let lastGain = favUrls.length;
    let noGain = 0;
    for (let i = 1; i <= pageLimit; i++) {
      await new Promise((r) => setTimeout(r, 1400));
      try {
        await win.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.parent-route-container') || document.querySelector('.route-scroll-container') || document.documentElement; el.scrollTop = ${i * 1500}; return 'ok'; })()`
        );
      } catch (e) { /* ignore */ }
      if (favUrls.length === lastGain) noGain++; else { lastGain = favUrls.length; noGain = 0; }
      try {
        event.sender.send('douyin-self-progress', { stage: 'scroll', page: i, total: pageLimit, fetched: favUrls.length });
      } catch (e) { /* ignore */ }
      if (noGain >= 3 && i >= 4) break; // 连续 3 次无新分页且至少滚了 4 次 → 数据已到底
    }
    await new Promise((r) => setTimeout(r, 2000));
    try { ses.webRequest.onBeforeSendHeaders(null); } catch (e) { /* ignore */ }

    // 3. 逐页 net.fetch 纯 HTTP 重放取数，推送进度
    const allAwemes = [];
    const seenIds = new Set();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
    const extractList = (j) => {
      if (!j) return [];
      const lk = cfg.listKey;
      if (Array.isArray(j[lk])) return j[lk];
      if (j.data && Array.isArray(j.data[lk])) return j.data[lk];
      if (Array.isArray(j.data)) return j.data;
      return [];
    };
    const collect = (list) => {
      for (const aw of list) {
        const id = aw && aw.aweme_id;
        if (!id || seenIds.has(String(id))) continue;
        seenIds.add(String(id));
        allAwemes.push(aw);
      }
    };

    const fetchPage = async (item, body) => {
      const url = typeof item === 'string' ? item : item.url;
      const uifid = (typeof item === 'object' && item.uifid) || '';
      const headers = {
        'User-Agent': UA,
        'Referer': targetUrl,
        'Accept': 'application/json, text/plain, */*',
        ...(uifid ? { 'uifid': uifid } : {}),
      };
      const opts = body !== null
        ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body }
        : { method: 'GET', headers };
      // 444/非JSON（间歇性风控，通常几十秒内恢复）自动重试：最多 4 次，间隔递增 2s/4s/8s
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await ses.fetch(url, opts);
          const text = await res.text();
          let j = null;
          try { j = JSON.parse(text); } catch (e) { /* ignore */ }
          if (j && j.status_code === 0) return j; // 成功
          if (res.status === 444 || !j) {
            if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
            continue;
          }
          return j; // 有 JSON 但 status_code 非 0，交给上层
        } catch (e) {
          if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
        }
      }
      return null;
    };

    if (cfg.method === 'POST') {
      // 收藏接口为 POST：先重放捕获的 URL（空 body 拿第一页），若 has_more 按 cursor 翻页
      let j = null;
      for (let i = 0; i < favUrls.length; i++) {
        event.sender.send('douyin-self-progress', { stage: 'fetch', page: i + 1, total: Math.max(favUrls.length, 1), fetched: allAwemes.length });
        j = await fetchPage(favUrls[i], '');
        collect(extractList(j));
        if (!(j && j.has_more)) break;
      }
      let cursor = j && j.cursor;
      let page = favUrls.length || 1;
      while (j && j.has_more && cursor && page < pageLimit) {
        event.sender.send('douyin-self-progress', { stage: 'fetch', page: page + 1, total: pageLimit, fetched: allAwemes.length });
        j = await fetchPage(favUrls[0] || targetUrl, `cursor=${cursor}`);
        collect(extractList(j));
        cursor = j && j.cursor;
        page++;
        await new Promise((r) => setTimeout(r, 300));
      }
    } else {
      // GET 接口：重放捕获到的各页 URL（每页自带签名 + uifid 头）
      for (let i = 0; i < favUrls.length; i++) {
        try {
          event.sender.send('douyin-self-progress', { stage: 'fetch', page: i + 1, total: favUrls.length, fetched: allAwemes.length });
          const j = await fetchPage(favUrls[i], null);
          collect(extractList(j));
        } catch (e) { /* 单页失败跳过 */ }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    try {
      event.sender.send('douyin-self-progress', { stage: 'fetch', page: pageLimit, total: pageLimit, fetched: allAwemes.length });
    } catch (e) { /* ignore */ }

    if (allAwemes.length === 0) {
      return { success: false, error: favUrls.length === 0 ? '未能捕获到数据接口请求，请稍后重试' : '接口暂被风控（已重试仍失败），请稍后再试' };
    }
    return { success: true, videos: allAwemes };
  } catch (error) {
    console.error('[Self] 获取我的账号数据失败:', error.message);
    return { success: false, error: error.message };
  }
});


// ===== 应用生命周期 =====
app.on('ready', async () => {
  try {
    createSplashScreen();

    console.log('[App] 使用原生Node.js API (无需Python后端)');

    // 初始化 SQLite 数据库（迁移旧 electron-store 数据）
    await db.initDatabase(app, store);
    migrateLegacyCookieSecrets();
    cleanupStaleCookieFiles({ maxAgeMs: 24 * 60 * 60 * 1000 });
    console.log('[App] 数据库已就绪');
    downloadScheduler.setLimit(getCurrentSettings().concurrency);

    // DB 就绪后用真实 cookie 重建 API 实例（启动早期从 electron-store 读到的可能为空）
    douyinAPI = buildDouyinAPI();
    tiktokAPI = buildTiktokAPI();

    // 从数据库载入监控状态（必须在 DB 初始化完成后）
    loadMonitorStateFromDB();

    // 把已保存的 Cookie 同步进分区会话，内置浏览器（webview 同 partition）启动即带登录态
    for (const plat of Object.keys(PLATFORM_COOKIE_CONFIG)) {
      syncCookiesToSession(plat).catch(() => {});
    }

    console.log('[App] 创建主窗口...');

    // 加载持久化的下载任务
    loadDownloadTasks();

    // Wait a bit for splash screen
    await new Promise(resolve => setTimeout(resolve, 1000));

    createMainWindow();

    // 启动关注监控
    startMonitor();

  } catch (error) {
    console.error('[App] 应用启动失败:', error);

    dialog.showErrorBox(
      '启动失败',
      `无法启动应用程序：\n\n${error.message}`
    );

    app.quit();
  }
});

// 退出前确保数据库落盘
app.on('before-quit', () => {
  try { db.flushBeforeQuit(); } catch (_) { /* ignore */ }
  try { kuaishouProfile.destroy(); } catch (_) { /* ignore */ }
  try { universalSniffer.stop(); } catch (_) { /* ignore */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  }
});

// 异常处理
process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception]', error);
});

process.on('unhandledRejection', (error) => {
  console.error('[Unhandled Rejection]', error);
});
