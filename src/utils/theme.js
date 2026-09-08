/**
 * 主题管理工具
 *
 * 设计：
 * - 主题通过 <html data-theme="..."> 属性切换，index.css 中按属性覆盖 CSS 变量。
 * - 持久化在 localStorage（即时读取，避免首屏闪烁），并同步到主进程设置（跨会话保留）。
 * - 应用启动时 index.html 中的内联脚本会在 React 加载前应用主题，确保无闪烁。
 */

export const THEMES = [
  {
    code: 'light',
    name: '浅色（默认）',
    desc: 'Notion / Linear 风',
    swatch: ['#f7f8fa', '#3370ff', '#1f2329'],
  },
  {
    code: 'dracula',
    name: 'Dracula',
    desc: '紫粉暗色 · dracula/dracula-theme',
    swatch: ['#282a36', '#bd93f9', '#ff79c6'],
  },
  {
    code: 'nord',
    name: 'Nord',
    desc: '极地夜空 · nordtheme/nord',
    swatch: ['#2e3440', '#88c0d0', '#a3be8c'],
  },
  {
    code: 'onedark',
    name: 'One Dark',
    desc: 'Atom 经典 · atom/one-dark-syntax',
    swatch: ['#282c34', '#61afef', '#98c379'],
  },
];

const STORAGE_KEY = 'app-theme';
const DEFAULT_THEME = 'light';

/**
 * 读取当前主题（localStorage 优先）
 */
export function getTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
  } catch (e) {
    return DEFAULT_THEME;
  }
}

/**
 * 应用主题到 <html>，并写入 localStorage
 * @param {string} theme 主题 code
 */
export function applyTheme(theme) {
  const code = THEMES.some(t => t.code === theme) ? theme : DEFAULT_THEME;
  const root = document.documentElement;
  if (code === DEFAULT_THEME) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', code);
  }
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch (e) {
    /* 忽略 localStorage 不可用的情况 */
  }
}

/**
 * 同步主题到主进程设置（持久化到磁盘，便于跨会话/迁移保留）
 */
export async function syncThemeToSettings(theme) {
  try {
    if (window.electronAPI && window.electronAPI.saveTheme) {
      await window.electronAPI.saveTheme(theme);
    }
  } catch (e) {
    /* 持久化失败不影响当前主题应用 */
  }
}

/**
 * 切换主题：应用 + 持久化
 */
export async function setTheme(theme) {
  applyTheme(theme);
  await syncThemeToSettings(theme);
}
