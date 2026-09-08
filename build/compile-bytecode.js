/**
 * 字节码编译脚本 -- 必须在 Electron 进程内运行
 *
 * 用法: electron build/compile-bytecode.js <appDir>
 *
 * 为什么必须在 Electron 内运行:
 *   bytenode 生成的 .jsc 字节码绑定 V8 版本。系统 Node 和 Electron 内置
 *   的 V8 版本不同,用系统 Node 编译的字节码在 Electron 里会报
 *   "Invalid or unexpected token"。本脚本由 Electron 启动,用其自身的 V8
 *   编译,版本天然匹配。
 *
 * 流程:
 *   1. 读取打包目录(参数)下的自有源码清单
 *   2. 用 bytenode.compileFile 编译成 .jsc(同目录)
 *   3. 编译成功后删除原始 .js 源码(仅自有代码,node_modules 不动)
 *
 * 注意: preload.js / preload-login.js 不参与字节码编译。
 *   Electron 的 preload 在沙箱(sandbox_bundle)里运行,其 require 是受限的,
 *   无法解析 node_modules(裸模块名 require('bytenode') 会报 module not found)。
 *   preload 本身只是 IPC 桥接(ipcRenderer.invoke 映射),不含敏感业务逻辑,
 *   原样保留即可,真正需要保护的是 main.js 和 src/native 下的解析逻辑。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 需要编译为字节码的自有源码(相对 appDir)
// 不含 node_modules / dist-react / 资源文件
// 注意:preload.js/preload-login.js 不在此列(沙箱环境无法 require bytenode)
const SOURCE_FILES = [
  'main-src.js',        // 真实 main 逻辑(已重命名,见 afterPack)
  // native 目录递归
];

// 递归收集目录下所有 .js
function collectJs(dir, base = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJs(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

(async () => {
  const appDir = process.argv[2];
  if (!appDir) {
    console.error('[Bytecode] 缺少 appDir 参数');
    app.exit(1);
  }

  const absAppDir = path.resolve(appDir);
  console.log('[Bytecode] 编译目录:', absAppDir);

  await app.whenReady();

  // 动态 require bytenode(打包后它在 appDir/node_modules)
  const bytenode = require(path.join(absAppDir, 'node_modules', 'bytenode'));

  // 判断是否为 ESM（前端模块，被 Vite 打包，主进程不 require，不能编译）
  function isESM(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return /^\s*(import\s|export\s)/m.test(content);
    } catch (e) {
      return false;
    }
  }

  // 收集目录下所有 CJS 文件（跳过 ESM）
  function collectCjsJs(dir, base = dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectCjsJs(full, base));
      } else if (entry.isFile() && entry.name.endsWith('.js') && !isESM(full)) {
        // 排除必须保持明文的文件：
        // sig_engine.js 是快手签名引擎源码，运行时被 kuaishouSign.js
        // fs.readFileSync 读取文本后 eval 执行（内部 var Jose 需在全局作用域），
        // 编译成 .jsc 后 readFileSync 会读到二进制字节码导致 eval 失败。
        if (entry.name === 'sig_engine.js') {
          console.log('[Bytecode] 跳过(需明文):', path.relative(base, full).replace(/\\/g, '/'));
          continue;
        }
        results.push(path.relative(base, full).replace(/\\/g, '/'));
      }
    }
    return results;
  }

  // 收集所有要编译的文件
  const files = [
    ...SOURCE_FILES.filter(f => fs.existsSync(path.join(absAppDir, f))),
    ...collectCjsJs(path.join(absAppDir, 'src', 'native')).map(f => 'src/native/' + f),
    ...collectCjsJs(path.join(absAppDir, 'src', 'utils')).map(f => 'src/utils/' + f),
  ];

  console.log('[Bytecode] 待编译文件 (' + files.length + '):');
  files.forEach(f => console.log('  -', f));

  let ok = 0;
  let fail = 0;
  for (const relFile of files) {
    const srcPath = path.join(absAppDir, relFile);
    const jscPath = srcPath.replace(/\.js$/, '.jsc');
    try {
      bytenode.compileFile({ filename: srcPath, output: jscPath });
      // 编译成功后删除源码
      fs.unlinkSync(srcPath);
      console.log('[Bytecode] ✓', relFile);
      ok++;
    } catch (e) {
      console.error('[Bytecode] ✗', relFile, '-', e.message);
      fail++;
    }
  }

  console.log(`[Bytecode] 完成: ${ok} 成功, ${fail} 失败`);
  app.exit(fail > 0 ? 1 : 0);
})();
