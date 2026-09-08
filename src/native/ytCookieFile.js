/**
 * yt-dlp Cookie 辅助（YouTube 登录态）
 *
 * 背景：YouTube 对无 cookie 的请求返回
 *   "Sign in to confirm you're not a bot"（bot 检测）。
 * yt-dlp 需要 --cookies <netscape文件> 或 --cookies-from-browser 传登录态。
 *
 * 本模块把应用里保存的 cookie_youtube（"name=value; ..." 字符串）转成
 * Netscape cookies.txt 临时文件，供解析（youtube.js）和下载（main.js）共用。
 *
 * 说明：YouTube 登录 cookie 是 Google 单点登录，同一组 name=value 同时存在于
 * .youtube.com 与 .google.com 域。字符串形式丢失了 domain 信息，这里统一挂到
 * .youtube.com（yt-dlp YouTube extractor 的请求域）。Secure 标记统一 TRUE
 * （YouTube 全站 https），多余的域条目对 CookieJar 按域路由、互相无害。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const YT_COOKIE_DOMAIN = '.youtube.com';
const COOKIE_FILE_PREFIXES = Object.freeze({
  youtube: ['youtube-cookies-', 'ytdl-cookies-'],
  bilibili: ['bilibili-cookies-'],
  xiaohongshu: ['xiaohongshu-cookies-'],
});
const OWNED_COOKIE_FILE = /^(?:youtube-cookies|bilibili-cookies|ytdl-cookies|xiaohongshu-cookies)-[a-f0-9]{12}\.txt$/i;

/**
 * 把 cookie_youtube 字符串转成 Netscape cookies.txt 内容
 * @param {string} cookieString  "name=value; name2=value2; ..."
 * @returns {string}
 */
function toNetscape(cookieString, domain = YT_COOKIE_DOMAIN) {
  const lines = ['# Netscape HTTP Cookie File'];
  const seen = new Set();
  for (const pair of String(cookieString || '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || seen.has(name)) continue; // 同名去重（不同域同名 cookie 值相同）
    seen.add(name);
    lines.push([
      domain, 'TRUE', '/', 'TRUE',
      Math.floor(Date.now() / 1000) + 30 * 86400,
      name, value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/**
 * 把 cookie 字符串写入临时 Netscape 文件，返回文件路径；无 cookie 时返回 null
 * @param {string} cookieString
 * @returns {string|null}
 */
function writeCookieFile(cookieString, { prefix = 'youtube-cookies', domain = YT_COOKIE_DOMAIN, tempDir = os.tmpdir() } = {}) {
  if (!cookieString || !String(cookieString).trim()) return null;
  const safePrefix = String(prefix || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safePrefix) throw new TypeError('cookie file prefix is required');
  const file = path.join(tempDir, `${safePrefix}-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(file, toNetscape(cookieString, domain), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return file;
}

/**
 * 构建 yt-dlp 参数：['--cookies', file]；无 cookie 返回 []
 * @param {string} cookieString
 * @returns {string[]}
 */
function buildYoutubeCookieArgs(cookieString) {
  const file = writeCookieFile(cookieString, {
    prefix: 'youtube-cookies',
    domain: YT_COOKIE_DOMAIN,
  });
  return file ? ['--cookies', file] : [];
}

function buildCookieArgs(cookieString, { platform, domain } = {}) {
  const normalizedPlatform = String(platform || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(COOKIE_FILE_PREFIXES, normalizedPlatform)) {
    throw new TypeError('unsupported cookie-file platform');
  }
  const prefix = COOKIE_FILE_PREFIXES[normalizedPlatform][0].replace(/-$/, '');
  const file = writeCookieFile(cookieString, { prefix, domain });
  return file ? ['--cookies', file] : [];
}

/**
 * 删除临时 cookie 文件（调用方在 yt-dlp 进程结束后调用）
 * @param {string|null} file
 */
function cleanupCookieFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (_) { /* 忽略 */ }
}

function cleanupCookieFiles({ platform, maxAgeMs = 0, now = Date.now(), tempDir = os.tmpdir() } = {}) {
  const prefixes = platform
    ? COOKIE_FILE_PREFIXES[String(platform).toLowerCase()] || []
    : Object.values(COOKIE_FILE_PREFIXES).flat();
  if (!prefixes.length) return 0;

  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(tempDir); } catch (_) { return 0; }
  for (const name of names) {
    if (!OWNED_COOKIE_FILE.test(name) || !prefixes.some(prefix => name.startsWith(prefix))) continue;
    const file = path.join(tempDir, name);
    if (maxAgeMs > 0) {
      try {
        const stat = fs.statSync(file);
        if ((now - stat.mtimeMs) < maxAgeMs) continue;
      } catch (_) {
        continue;
      }
    }
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (_) { /* 运行中的文件由调用方 finally 清理 */ }
  }
  return removed;
}

function cleanupStaleCookieFiles(options = {}) {
  return cleanupCookieFiles({ ...options, platform: undefined });
}

module.exports = {
  toNetscape,
  writeCookieFile,
  buildYoutubeCookieArgs,
  buildCookieArgs,
  cleanupCookieFile,
  cleanupCookieFiles,
  cleanupStaleCookieFiles,
};
