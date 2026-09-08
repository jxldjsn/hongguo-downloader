import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Copy, Trash2, Download, RefreshCw, ChevronRight, Link2, X, ExternalLink } from './icons';
import './QuickBrowser.css';

const HOME_URL = 'https://www.douyin.com/';

// 注入 webview 页面执行：收集页面上所有抖音视频/笔记链接，统一规范化为
// https://www.douyin.com/video/{id}。扫描四处：
//   1) <a> 锚点（DOM 的 a.href 已自动把 // 协议相对链接转绝对）
//   2) data-aweme-id 属性 —— 搜索/精选页卡片（<div class="discover-video-card-item"
//      data-aweme-id="...">）的权威来源，有的卡片没有 <a> 只有这个属性
//   3) 页面文本里的完整链接
//   4) 兜底：整页 HTML 正则扫描（覆盖 JS 渲染、懒加载内容）
// 支持 /video/、/note/、modal_id= 三种形式。
const EXTRACT_SCRIPT = `
(() => {
  const out = new Set();
  const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return null; } };
  document.querySelectorAll('a[href]').forEach((a) => {
    const h = abs(a.href);
    if (h) out.add(h);
  });
  document.querySelectorAll('[data-aweme-id]').forEach((el) => {
    const id = (el.getAttribute('data-aweme-id') || '').trim();
    if (/^\\d{6,}$/.test(id)) out.add('https://www.douyin.com/video/' + id);
  });
  const text = (document.body ? document.body.innerText : '');
  const re = /https?:\\/\\/[^\\s"'<>()]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  try {
    const html = document.documentElement.outerHTML;
    const idRe = /(?:^|\\/)(?:video|note)\\/(\\d{6,})/g;
    let vm;
    while ((vm = idRe.exec(html)) !== null) out.add('https://www.douyin.com/video/' + vm[1]);
    const attrRe = /data-aweme-id="(\\d{6,})"/g;
    while ((vm = attrRe.exec(html)) !== null) out.add('https://www.douyin.com/video/' + vm[1]);
  } catch (e) { /* ignore */ }
  const links = [];
  out.forEach((raw) => {
    const u = raw.split('?')[0].split('#')[0];
    const mm = u.match(/(?:^|\\/)(?:video|note)\\/(\\d{6,})$/);
    if (mm) { links.push('https://www.douyin.com/video/' + mm[1]); return; }
    const qm = raw.match(/modal_id=(\\d{6,})/);
    if (qm) links.push('https://www.douyin.com/video/' + qm[1]);
  });
  return [...new Set(links)];
})()`;

// 注入 webview 页面执行一次：挂钩 fetch / XHR，监听抖音 API 响应，
// 从返回 JSON 里提取 aweme_id（搜索/推荐/滚动分页的数据都在这里）。
// 页面 DOM 是虚拟滚动的（旧卡片会被回收），但网络响应不会丢，
// 所以滚动加载的内容靠这个通道收集，提取结果通过 console.log 标记行
// 传给外层（webview 的 console-message 事件）。
const INJECT_CAPTURE_SCRIPT = `
(() => {
  if (window.__qbCaptureInstalled) return;
  window.__qbCaptureInstalled = true;
  const report = (text) => {
    try {
      if (!text || typeof text !== 'string') return;
      const ids = [];
      const re = /"(?:aweme_id|awemeId)"\\s*:\\s*"?([0-9]{15,})"?/g;
      let m;
      while ((m = re.exec(text)) !== null) ids.push(m[1]);
      const re2 = /\\/(?:video|note)\\/([0-9]{15,})/g;
      while ((m = re2.exec(text)) !== null) ids.push(m[1]);
      if (ids.length) console.log('QB_CAPTURE:' + JSON.stringify([...new Set(ids)]));
    } catch (e) {}
  };
  const goodUrl = (u) => { try { return /(aweme|feed|search|video|note)/i.test(String(u || '')); } catch (e) { return false; } };
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        const args = arguments;
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
        const ok = goodUrl(url);
        return origFetch.apply(this, args).then((res) => {
          if (ok) { try { res.clone().text().then(report).catch(() => {}); } catch (e) {} }
          return res;
        });
      };
    }
  } catch (e) {}
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function () {
        this.__qbUrl = arguments[1];
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        const self = this;
        this.addEventListener('load', () => {
          if (goodUrl(self.__qbUrl)) { try { report(self.responseText); } catch (e) {} }
        });
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}
})()`;

export default function QuickBrowser({ onAddLinks }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(HOME_URL);
  const [src, setSrc] = useState(HOME_URL);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copiedMsg, setCopiedMsg] = useState(null);
  const [parseMsg, setParseMsg] = useState(null);
  const webviewRef = useRef(null);
  // 始终持有最新 links，供 sweep 计算本次新增条数（避免闭包过期）
  const linksRef = useRef([]);
  useEffect(() => { linksRef.current = links; }, [links]);
  // 网络捕获缓冲：滚动分页时页面请求到的 aweme_id（只在点「解析本页」时并入）
  const capturedRef = useRef(new Set());

  // 扫描当前页面并追加收集到的作品链接（自动去重），返回本次新增条数
  const sweep = useCallback(async () => {
    const wv = webviewRef.current;
    if (!wv || !wv.executeJavaScript) return 0;
    try {
      const res = await wv.executeJavaScript(EXTRACT_SCRIPT);
      if (!Array.isArray(res) || res.length === 0) return 0;
      const fresh = res.filter((l) => !linksRef.current.includes(l));
      if (fresh.length === 0) return 0;
      setLinks((prev) => {
        const seen = new Set(prev);
        return [...prev, ...fresh.filter((l) => !seen.has(l))];
      });
      return fresh.length;
    } catch (e) {
      return 0; /* 页面未就绪等，忽略 */
    }
  }, []);

  // 把网络捕获缓冲里收集到的 aweme_id 并入链接列表，返回新增条数
  const flushCaptured = () => {
    const ids = Array.from(capturedRef.current);
    capturedRef.current = new Set();
    if (!ids.length) return 0;
    const fresh = ids
      .map((id) => `https://www.douyin.com/video/${id}`)
      .filter((u) => !linksRef.current.includes(u));
    if (!fresh.length) return 0;
    setLinks((prev) => {
      const seen = new Set(prev);
      return [...prev, ...fresh.filter((l) => !seen.has(l))];
    });
    return fresh.length;
  };

  // 手动「解析本页」（不做任何自动解析）：DOM 扫描 + 网络捕获缓冲一并并入
  const parsePage = async () => {
    const domAdded = await sweep();
    const netAdded = flushCaptured();
    const added = domAdded + netAdded;
    setParseMsg(added > 0 ? `已解析到 ${added} 条新链接` : '本页未发现新链接');
    setTimeout(() => setParseMsg(null), 2000);
  };

  // 弹窗 ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // webview 事件挂载（StrictMode 双挂载下有 cleanup 兜底）
  // 地址栏/加载状态同步 + 网络捕获挂钩（不自动解析，只缓冲数据）
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onUrlChange = (e) => { if (e && e.url) setAddress(e.url); };
    const onStart = () => setLoading(true);
    const onStop = () => setLoading(false);
    // 页面加载完成（含整页跳转）后注入 fetch/XHR 挂钩；SPA 内部跳转不会重载脚本，挂钩一直生效
    const onDomReady = () => {
      if (wv.executeJavaScript) wv.executeJavaScript(INJECT_CAPTURE_SCRIPT).catch(() => {});
    };
    // 页面 console 里带 QB_CAPTURE: 前缀的标记行 -> 网络响应里的 aweme_id
    const onConsole = (e) => {
      if (!e || typeof e.message !== 'string') return;
      const marker = 'QB_CAPTURE:';
      const idx = e.message.indexOf(marker);
      if (idx < 0) return;
      try {
        const ids = JSON.parse(e.message.slice(idx + marker.length));
        if (Array.isArray(ids) && ids.length) {
          ids.forEach((id) => capturedRef.current.add(String(id)));
        }
      } catch (err) { /* ignore */ }
    };
    wv.addEventListener('did-navigate', onUrlChange);
    wv.addEventListener('did-navigate-in-page', onUrlChange);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('console-message', onConsole);
    return () => {
      wv.removeEventListener('did-navigate', onUrlChange);
      wv.removeEventListener('did-navigate-in-page', onUrlChange);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('console-message', onConsole);
    };
  }, []);

  const navigate = (url) => {
    const u = String(url || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      setAddress(`https://${u}`);
      setSrc(`https://${u}`);
    } else {
      setAddress(u);
      setSrc(u);
    }
  };
  const goBack = () => { try { webviewRef.current && webviewRef.current.goBack(); } catch (e) { /* ignore */ } };
  const goForward = () => { try { webviewRef.current && webviewRef.current.goForward(); } catch (e) { /* ignore */ } };
  const reload = () => { try { webviewRef.current && webviewRef.current.reload(); } catch (e) { /* ignore */ } };

  const copyAll = async () => {
    if (!links.length) return;
    try {
      await window.electronAPI.copyText(links.join('\n'));
      setCopiedMsg(`已复制 ${links.length} 条`);
    } catch (err) {
      setCopiedMsg('复制失败');
    }
    setTimeout(() => setCopiedMsg(null), 1600);
  };
  const copyOne = async (l) => {
    try {
      await window.electronAPI.copyText(l);
      setCopiedMsg('已复制 1 条');
    } catch (err) {
      setCopiedMsg('复制失败');
    }
    setTimeout(() => setCopiedMsg(null), 1600);
  };
  const removeLink = (l) => setLinks((prev) => prev.filter((x) => x !== l));
  const clearLinks = () => setLinks([]);
  const fillUrlBox = () => { if (onAddLinks && links.length) onAddLinks([...links]); };

  return (
    <>
      {/* 触发按钮（卡片内） */}
      <button className="qb-open-btn" onClick={() => setOpen(true)}>
        <Link2 size={15} className="qb-toggle-icon" />
        内置浏览器
        <span className="qb-hint">弹窗浏览抖音，点「解析本页」收集页面上的视频链接</span>
        <ExternalLink size={13} className="qb-open-arrow" />
      </button>

      {/* 浏览器弹窗（常驻 DOM，关闭仅隐藏，保留会话与已收集的链接） */}
      <div className="qb-modal-overlay" style={{ display: open ? 'flex' : 'none' }} onClick={() => setOpen(false)}>
        <div className="qb-modal" onClick={(e) => e.stopPropagation()}>
          <div className="qb-modal-head">
            <span className="qb-modal-title">
              <Link2 size={15} />
              内置浏览器
              <span className="qb-hint">与「抖音登录」共享登录态 · 点「解析本页」收集视频链接</span>
            </span>
            <button className="qb-modal-close" onClick={() => setOpen(false)} title="关闭 (Esc)">
              <X size={16} />
            </button>
          </div>

          <div className="qb-toolbar">
            <button className="qb-nav-btn" onClick={goBack} title="后退" disabled={loading}>←</button>
            <button className="qb-nav-btn" onClick={goForward} title="前进" disabled={loading}>→</button>
            <button className="qb-nav-btn" onClick={reload} title="刷新" disabled={loading}>
              <RefreshCw size={13} />
            </button>
            <div className="qb-address">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(address); }}
                placeholder="输入网址，回车打开，例如 https://www.douyin.com"
                spellCheck={false}
              />
              <button className="qb-go" onClick={() => navigate(address)} title="前往">
                <ChevronRight size={14} />
              </button>
            </div>
            <button className="qb-home-btn" onClick={() => navigate(HOME_URL)}>抖音首页</button>
          </div>

          <div className="qb-webview-wrap">
            {loading && <div className="qb-loading-bar" />}
            {/* partition 与「抖音登录」窗口共用 persist:douyin，登录后内置浏览器自动带登录态 */}
            <webview ref={webviewRef} src={src} className="qb-webview" partition="persist:douyin" />
          </div>

          <div className="qb-links">
            <div className="qb-links-head">
              <span>
                <Link2 size={13} />
                解析到的作品链接
                <span className="qb-count">{links.length}</span>
              </span>
              <div className="qb-links-actions">
                <button className="btn btn-primary btn-sm" onClick={parsePage} disabled={loading} title="扫描当前页面里的所有视频/笔记链接（含懒加载内容）">
                  <RefreshCw size={13} />
                  {parseMsg || '解析本页'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={copyAll} disabled={!links.length} title="复制全部链接，每行一条">
                  <Copy size={13} />
                  {copiedMsg || '复制全部（一行一个）'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={fillUrlBox} disabled={!links.length} title="把链接填入上方下载框，直接解析下载">
                  <Download size={13} />
                  填入下载框
                </button>
                <button className="btn btn-secondary btn-sm" onClick={clearLinks} disabled={!links.length} title="清空列表">
                  <Trash2 size={13} />
                  清空
                </button>
              </div>
            </div>

            {links.length === 0 ? (
              <div className="qb-empty">
                在浏览器中打开抖音视频页 / 搜索结果页，点「解析本页」收集链接；滚动加载的新内容也会一并收集
              </div>
            ) : (
              <div className="qb-link-list">
                {links.map((l, i) => (
                  <div className="qb-link-item" key={l}>
                    <span className="qb-link-idx">{i + 1}</span>
                    <span className="qb-link-url" title={l}>{l}</span>
                    <button className="qb-link-btn" onClick={() => copyOne(l)} title="复制这条链接">
                      <Copy size={12} />
                    </button>
                    <button className="qb-link-btn qb-link-del" onClick={() => removeLink(l)} title="删除">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
