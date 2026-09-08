import React, { useState, useEffect } from 'react';
import './AdDisplay.css';

const ALLOWED_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main',
  'p', 'span', 'strong', 'b', 'em', 'i', 'u', 'small',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'br', 'hr', 'img',
]);
const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'video', 'audio',
]);
const GLOBAL_ATTRIBUTES = new Set(['class', 'title', 'role', 'aria-label']);

function AdDisplay() {
  const [html, setHtml] = useState('');
  const [promoUrl, setPromoUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadPromo();
  }, []);

  const loadPromo = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.getControlPanelPromo();
      if (result.success) {
        // 远端 HTML 不可信：净化后再渲染，移除 <script>/事件处理器/javascript: 链接等 XSS 载荷
        setHtml(sanitizeHtml(result.html || ''));
        setPromoUrl(normalizePromoUrl(result.url));
      } else {
        setError(result.error || '获取推广内容失败');
      }
    } catch (err) {
      console.error('加载推广内容失败:', err);
      setError(err.message || '加载推广内容失败');
    } finally {
      setLoading(false);
    }
  };

  const normalizePromoUrl = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
      return parsed.toString();
    } catch (_) {
      return '';
    }
  };

  // 远端 HTML 采用显式标签/属性白名单；表单、导航和可执行节点全部排除。
  const sanitizeHtml = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      [...doc.body.querySelectorAll('*')].forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          if (BLOCKED_TAGS.has(tag)) el.remove();
          else el.replaceWith(...el.childNodes);
          return;
        }
        [...el.attributes].forEach((attr) => {
          const name = attr.name.toLowerCase();
          const imageAttribute = tag === 'img' && ['src', 'alt', 'width', 'height', 'loading'].includes(name);
          if (!GLOBAL_ATTRIBUTES.has(name) && !imageAttribute) {
            el.removeAttribute(attr.name);
            return;
          }
          if (tag === 'img' && name === 'src') {
            try {
              const imageUrl = new URL(attr.value);
              if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password) {
                el.removeAttribute(attr.name);
              } else {
                el.setAttribute('src', imageUrl.toString());
              }
            } catch (_) {
              el.removeAttribute(attr.name);
            }
          }
        });
      });
      return doc.body ? doc.body.innerHTML : '';
    } catch (e) {
      // 解析失败则原样不渲染，避免不可控 HTML 直接注入
      console.warn('[AdDisplay] HTML 净化失败，已忽略内容:', e.message);
      return '';
    }
  };

  if (loading) {
    return (
      <div className="ad-display-page fade-in">
        <div className="card">
          <div className="loading-spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ad-display-page fade-in">
      {error && (
        <div className="alert alert-danger">
          {error}
        </div>
      )}

      {/* 有网址则用 iframe 直接加载网页，没有则渲染自定义 HTML */}
      {promoUrl ? (
        <iframe
          src={promoUrl}
          title="推广信息"
          className="promo-iframe"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div
          className="promo-html-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      <div className="actions-bar">
        <button className="btn btn-secondary" onClick={loadPromo}>
          <span>↻</span>
          刷新
        </button>
      </div>
    </div>
  );
}

export default AdDisplay;
