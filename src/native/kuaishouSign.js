/**
 * 快手 __NS_hxfalcon 签名引擎封装（纯 Node，无浏览器依赖）
 *
 * 签名引擎来源：快手 PC Web 前端 bundle 中的 hxfalcon 自研 VM（Fiber 字节码解释器 +
 * jmpOnw_* 加密原语），已完整提取到 sig_engine.js。
 *
 * 生成流程（与页面 $encode 一致）：
 *   1. jmpOnw_ms(input)   -> 签名输入串（url + 排序后的 query/form + cookie + requestBody）
 *   2. KsGuard.collectDeviceInfo() -> 设备信息（HUDR_ 前缀部分）
 *   3. SHA-256 变体 + 流密码混淆 + hex -> $HE_ 前缀的签名主体
 *   4. 拼接为 __NS_hxfalcon 值
 *
 * 注意：引擎通过全局 eval 加载（引擎内部用 window/document/Object 全局，
 * 且加密原语注册在全局 Object 上）。加载后不可卸载，仅需加载一次。
 */

const fs = require('fs');
const path = require('path');

let engineLoaded = false;
let Jose = null;

/**
 * 加载签名引擎源码。
 *
 * 兼容两种形态：
 *   - 源码环境：encrypt/kuaishou/sig_engine.js（明文，readFileSync + eval）
 *   - 打包环境：afterPack 会把 src/native 下所有 CJS .js 编译为 .jsc 并删除源码，
 *     此时 sig_engine.js 已不存在，需用 bytenode 加载 sig_engine.jsc
 *     （字节码与 Electron V8 版本匹配，不能用系统 Node 的 bytenode）。
 */
function loadEngineSource() {
  const engineDir = path.join(__dirname, 'encrypt', 'kuaishou');
  const jsPath = path.join(engineDir, 'sig_engine.js');
  if (fs.existsSync(jsPath)) {
    return fs.readFileSync(jsPath, 'utf8');
  }
  const jscPath = path.join(engineDir, 'sig_engine.jsc');
  if (fs.existsSync(jscPath)) {
    // 打包环境：用 bytenode 加载 .jsc（Electron 内置 V8，由 electron-builder 的
    // afterPack 用同一 Electron 编译，版本天然匹配）
    const bytenode = require('bytenode');
    // bytenode 会把 .jsc 作为模块加载并执行，但其 exports 是模块导出，
    // 而 sig_engine.jsc 是「var Jose = ...」的全局 IIFE，没有 module.exports。
    // 直接 require 会执行全局代码（var Jose 进入全局），这里捕获执行结果。
    try {
      require(jscPath);
    } catch (e) {
      // 某些情况 bytenode 对无导出模块报错，但全局副作用（var Jose）已生效
      console.warn('[KsSign] bytenode 加载 sig_engine.jsc:', e.message);
    }
    return ''; // 全局 Jose 已由 require 副作用设置
  }
  throw new Error('快手签名引擎缺失: ' + engineDir);
}

/**
 * 加载签名引擎（幂等，仅首次执行 eval）
 */
function ensureEngine() {
  if (engineLoaded && Jose) return Jose;
  // 模拟浏览器全局（与引擎共享同一 realm，避免 vm 隔离导致 Int8Array 跨 realm 失败）
  global.window = global;
  global.globalThis = global;
  global.SECS = {};
  global.navigator = { sendBeacon: () => true };
  global.performance = { now: () => Date.now() };
  if (!global.document || typeof global.document !== 'object') {
    global.document = { cookie: '' };
  }

  const engineSrc = loadEngineSource();
  if (engineSrc) {
    // 间接 eval：var Jose 声明到全局，不污染本模块作用域
    (0, eval)(engineSrc);
  }
  Jose = global.Jose;
  if (!Jose || !Jose.realm || !Jose.realm.global) {
    throw new Error('快手签名引擎加载失败');
  }
  engineLoaded = true;
  return Jose;
}

/**
 * 生成 __NS_hxfalcon 签名
 * @param {string} url - API 路径，如 '/rest/v/profile/feed'
 * @param {object} query - 请求参数（会与签名一起发送）
 * @param {string} cookie - 当前登录 cookie 串（参与签名）
 * @returns {Promise<string>} 签名值
 */
function genSignature(url, query, cookie) {
  const j = ensureEngine();
  if (global.document) {
    global.document.cookie = cookie || '';
  }
  const signInput = {
    url,
    query: query || {},
    form: {},
    requestBody: {},
  };
  return new Promise((resolve, reject) => {
    try {
      j.call('$encode', [signInput, {
        suc: (sig) => resolve(sig),
        err: (e) => reject(new Error('快手签名失败: ' + (typeof e === 'object' ? JSON.stringify(e) : String(e)))),
      }]);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 获取签名版本号（caver 参数值）
 */
function getCatVersion() {
  const j = ensureEngine();
  try {
    return String(j.call('$getCatVersion') || '');
  } catch (e) {
    return '';
  }
}

module.exports = { genSignature, getCatVersion, ensureEngine };
