/**
 * 静态检查 AccountManager.jsx 中是否存在未声明（undefined）的变量引用。
 * 用法: node _check_undefined_refs.js <file>
 * 原理: babel 遍历作用域，对所有"被引用的 Identifier"检查是否在当前作用域
 *       有绑定、或者是合法全局。未绑定且非全局 -> 打印报告，exit 1。
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const file = process.argv[2] || path.join(__dirname, 'src/components/AccountManager.jsx');
const code = fs.readFileSync(file, 'utf8');

// 合法浏览器/Node 全局（白名单，避免误报）
const GLOBALS = new Set([
  'window','document','localStorage','sessionStorage','console','JSON','Date','String',
  'Number','Math','Array','Object','Set','Promise','alert','confirm','setTimeout','clearTimeout',
  'setInterval','clearInterval','parseInt','parseFloat','isNaN','isFinite','Infinity',
  'undefined','NaN','Boolean','Error','TypeError','Symbol','RegExp','Map','WeakMap',
  'fetch','FormData','URL','AbortController','Blob','navigator','location','performance',
  'process','Buffer','require','module','exports','global','TextEncoder','TextDecoder',
  'FileReader','Image','Audio','requestAnimationFrame','crypto','Intl','encodeURIComponent',
  'decodeURIComponent','encodeURI','decodeURI','Event','CustomEvent','XMLHttpRequest',
  'WebSocket','atob','btoa','__dirname','__filename','globalThis','structuredClone','URLSearchParams',
]);

const ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });

const problems = [];
traverse(ast, {
  Identifier(path) {
    if (!path.isReferencedIdentifier()) return;
    const name = path.node.name;
    if (path.scope.hasBinding(name)) return;
    if (GLOBALS.has(name)) return;
    // 确认不是函数名/类名自身的引用（hasBinding 已覆盖），也不是 JSX 标签
    const loc = path.node.loc ? `:${path.node.loc.start.line}` : '';
    problems.push(`未声明引用: ${name} (${file}${loc})`);
  },
});

if (problems.length) {
  console.log(`发现 ${problems.length} 个未声明变量引用:`);
  problems.forEach(p => console.log('  ' + p));
  process.exit(1);
} else {
  console.log('OK: 未发现未声明变量引用');
}
