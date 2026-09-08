/**
 * 从本机 Chromium 内核浏览器（Chrome / Edge / Brave）读取并解密抖音 Cookie
 *
 * 原理：
 *  1. 浏览器 Cookie 存于 SQLite 数据库（cookies 表，值为 encrypted_value BLOB）
 *  2. Cookie 值用 AES-256-GCM 加密（v10/v11 前缀），密钥保存在 Local State，被 Windows DPAPI 保护
 *  3. 用 PowerShell 调 DPAPI 解出 AES 密钥，再用 Node crypto 解密每条 Cookie
 *
 * 仅支持 Windows。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// 各浏览器的 User Data 目录
const BROWSERS = {
  chrome: { name: 'Chrome', userData: path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data') },
  edge: { name: 'Edge', userData: path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data') },
  brave: { name: 'Brave', userData: path.join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data') },
};

// 列出可用浏览器
function listAvailableBrowsers() {
  return Object.entries(BROWSERS)
    .filter(([, info]) => fs.existsSync(info.userData))
    .map(([key, info]) => ({ key, name: info.name }));
}

// 用 DPAPI 解密一段数据，返回 Buffer
function dpapiUnprotect(encryptedBuffer) {
  const b64 = encryptedBuffer.toString('base64');
  const psCmd =
    `Add-Type -AssemblyName System.Security; ` +
    `$enc=[Convert]::FromBase64String('${b64}'); ` +
    `$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,'CurrentUser'); ` +
    `[Convert]::ToBase64String($dec)`;
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    { encoding: 'utf8', windowsHide: true }
  );
  return Buffer.from(out.trim(), 'base64');
}

// 从 Local State 读取并解密 AES 主密钥
function getAesKey(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new Error('未找到浏览器 Local State 文件');
  }
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new Error('Local State 中未找到加密密钥');
  }
  let encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
  // 去掉 "DPAPI" 前缀（5 字节）
  if (encryptedKey.slice(0, 5).toString() === 'DPAPI') {
    encryptedKey = encryptedKey.slice(5);
  }
  return dpapiUnprotect(encryptedKey);
}

// 解密单条 Cookie 值（仅支持 v10/v11 AES-GCM；v20 应用绑定加密无法在普通权限下解密）
// 返回 { value, prefix }，无法解密时 value 为 null
function decryptCookieValue(encryptedValue, aesKey) {
  if (!encryptedValue || encryptedValue.length === 0) return { value: null, prefix: '' };
  const buf = Buffer.from(encryptedValue);
  const prefix = buf.slice(0, 3).toString('latin1');

  if (prefix === 'v10' || prefix === 'v11') {
    try {
      const nonce = buf.slice(3, 15);
      const tag = buf.slice(buf.length - 16);
      const ciphertext = buf.slice(15, buf.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return { value: decrypted.toString('utf8'), prefix };
    } catch (e) {
      return { value: null, prefix };
    }
  }

  // v20（应用绑定加密）或其它方案：普通权限无法解密
  return { value: null, prefix };
}

// 复制被 Chrome 锁定的 SQLite 文件到临时文件
// 浏览器运行时会对 Cookies 文件加排他锁（不共享任何访问），
// 此时 fs.copyFileSync / fs.openSync / PowerShell File.Open(FileShare.ReadWrite) 全部报 EBUSY。
// 只有管理员权限的 robocopy /B 或 VSS 卷影复制才能读出被独占的文件，
// 普通用户权限下无法绕过，只能提示用户先关闭浏览器。
function copyLockedFile(src, dest) {
  // 先用普通的 copyFileSync（浏览器未运行时文件未锁，直接成功）
  fs.copyFileSync(src, dest);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  // 极少数情况：复制成功但为空，按失败处理
  const err = new Error('复制后文件为空');
  err.code = 'ENOENT';
  throw err;
}

// 检测浏览器进程是否正在运行（Windows：通过 tasklist）
function isBrowserRunning(browserKey) {
  const procName = { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' }[browserKey];
  if (!procName) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${procName}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /INFO:\s*没有运行|No tasks/i.test(out) ? false : out.includes(procName);
  } catch (_) {
    return false; // 探测失败时不阻止，留给后续 copyFile 暴露真实错误
  }
}

// 找到包含 cookies 的数据库文件（新版在 Network 子目录）
function findCookieDb(userDataDir, profile = 'Default') {
  const candidates = [
    path.join(userDataDir, profile, 'Network', 'Cookies'),
    path.join(userDataDir, profile, 'Cookies'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * 读取指定浏览器中 douyin.com 的 Cookie，返回 cookieString
 * @param {string} browserKey - chrome | edge | brave
 * @param {string} domainFilter - 默认 douyin.com
 */
async function getCookiesFromBrowser(browserKey = 'chrome', domainFilter = 'douyin.com') {
  const browser = BROWSERS[browserKey];
  if (!browser) throw new Error(`不支持的浏览器: ${browserKey}`);
  if (!fs.existsSync(browser.userData)) {
    throw new Error(`未检测到 ${browser.name} 浏览器`);
  }

  const dbPath = findCookieDb(browser.userData);
  if (!dbPath) {
    throw new Error(`未找到 ${browser.name} 的 Cookie 数据库`);
  }

  // 解密 AES 主密钥
  const aesKey = getAesKey(browser.userData);

  // 复制数据库到临时文件（浏览器运行时会锁定原文件）
  const tmpDb = path.join(os.tmpdir(), `dy_cookies_${Date.now()}.db`);
  let copyFailed = false;
  let copyErr = null;
  try {
    copyLockedFile(dbPath, tmpDb);
  } catch (e) {
    copyFailed = true;
    copyErr = e;
  }

  if (copyFailed) {
    // 浏览器运行时会独占锁定 Cookies 文件，普通权限无法读出
    if (isBrowserRunning(browserKey)) {
      throw new Error(
        `${browser.name} 正在运行，Cookie 文件被锁定。请先「完全退出」${browser.name}` +
        `（任务栏右键退出，或任务管理器结束 ${browser.name} 进程），再重新点击导入；` +
        `不想关闭浏览器也可改用「应用内登录」。`
      );
    }
    // 浏览器没运行却仍失败，给出原始错误
    const code = copyErr && copyErr.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error(`Cookie 文件被锁定（${code}），请确认没有其它程序占用后重试。`);
    }
    throw new Error(`读取 ${browser.name} Cookie 文件失败: ${(copyErr && copyErr.message) || code}`);
  }

  let cookieMap = {};
  let appBoundCount = 0;
  let okCount = 0;
  try {
    const initSqlJs = require('sql.js');
    const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });

    const fileBuffer = fs.readFileSync(tmpDb);
    const db = new SQL.Database(fileBuffer);

    const result = db.exec(
      `SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE '%${domainFilter}'`
    );
    db.close();

    if (result.length > 0) {
      const rows = result[0].values;
      for (const [hostKey, name, encryptedValue] of rows) {
        const { value, prefix } = decryptCookieValue(encryptedValue, aesKey);
        if (prefix === 'v20') appBoundCount++;
        if (name && value) {
          cookieMap[name] = value;
          okCount++;
        }
      }
    }
  } finally {
    try { fs.unlinkSync(tmpDb); } catch (_) { /* ignore */ }
  }

  const names = Object.keys(cookieMap);
  if (names.length === 0) {
    if (appBoundCount > 0) {
      throw new Error(
        `${browser.name} 使用了新版“应用绑定加密(v20)”，无法直接读取 Cookie。请改用“应用内登录”或“手动粘贴 Cookie”。`
      );
    }
    throw new Error(`${browser.name} 中未找到 ${domainFilter} 的 Cookie，请确认已在该浏览器登录对应平台账号`);
  }

  const cookieString = names.map((n) => `${n}=${cookieMap[n]}`).join('; ');
  return { cookieString, count: names.length };
}

module.exports = { getCookiesFromBrowser, listAvailableBrowsers };
