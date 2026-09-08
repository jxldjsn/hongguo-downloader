import React, { useState, useMemo, useRef } from 'react';
import './TextTool.css';

/**
 * 文本处理工具页面（对标 https://txttool.cn/extract-link/）
 * 从任意文本/网页源码/文档中批量提取 URL 链接。
 *
 * 增强：针对本下载器场景，可识别抖音/TikTok/快手等支持的平台并打标签，
 * 一键复制 / 导出 TXT / 发送链接到剪贴板。
 */
function TextTool() {
  const [inputText, setInputText] = useState('');
  const [results, setResults] = useState([]); // [{ url, protocol, host, platform }]
  const [extractedCount, setExtractedCount] = useState(0); // 去重前总数

  // 提取选项
  const [onlyVideoLinks, setOnlyVideoLinks] = useState(false);
  const [dedupe, setDedupe] = useState(true);
  const [stripQuery, setStripQuery] = useState(false);
  const [onlyDomain, setOnlyDomain] = useState(false);

  const fileInputRef = useRef(null);

  // 已知视频平台识别规则（用于打标签 + 「仅视频链接」过滤）
  const PLATFORM_RULES = [
    { code: 'douyin', name: '抖音', pattern: /douyin\.com|iesdouyin\.com|v\.douyin\.com/i, color: '#161823' },
    { code: 'tiktok', name: 'TikTok', pattern: /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i, color: '#000000' },
    { code: 'kuaishou', name: '快手', pattern: /kuaishou\.com|chenzhongtech\.com|gifshow\.com/i, color: '#FF4906' },
    { code: 'xiaohongshu', name: '小红书', pattern: /xiaohongshu\.com|xhslink\.com/i, color: '#FF2442' },
    { code: 'bilibili', name: '哔哩哔哩', pattern: /bilibili\.com|b23\.tv/i, color: '#FB7299' },
    { code: 'weibo', name: '微博', pattern: /weibo\.com|weibo\.cn|t\.cn\/[A-Za-z0-9]/i, color: '#E6162D' },
    { code: 'xigua', name: '西瓜视频', pattern: /ixigua\.com/i, color: '#F04142' },
    { code: 'huoshan', name: '火山', pattern: /huoshan\.com/i, color: '#FF3E45' },
    { code: 'weishi', name: '微视', pattern: /weishi\.qq\.com/i, color: '#12B7F5' },
    { code: 'pipixia', name: '皮皮虾', pattern: /pipix\.com|h5\.pipix/i, color: '#FF8226' },
    { code: 'youtube', name: 'YouTube', pattern: /youtube\.com|youtu\.be/i, color: '#FF0000' },
    { code: 'haokan', name: '好看视频', pattern: /haokan\.baidu\.com/i, color: '#2932E1' },
    { code: 'acfun', name: 'A站', pattern: /acfun\.cn/i, color: '#FD4C5D' },
    { code: 'huya', name: '虎牙', pattern: /huya\.com/i, color: '#FFA800' },
  ];

  const identifyPlatform = (url) => {
    for (const p of PLATFORM_RULES) {
      if (p.pattern.test(url)) return p;
    }
    return null;
  };

  // 提取协议 + URL 的核心正则
  // 匹配 http(s):// ftp:// file:// 开头的合法 URL
  const URL_REGEX = /\b(https?:\/\/[^\s"'<>\u4e00-\u9fa5]+|ftp:\/\/[^\s"'<>\u4e00-\u9fa5]+|file:\/\/\/?[^\s"'<>\u4e00-\u9fa5]+)/gi;

  const handleExtract = () => {
    if (!inputText.trim()) {
      setResults([]);
      setExtractedCount(0);
      return;
    }

    const matches = inputText.match(URL_REGEX) || [];
    setExtractedCount(matches.length);

    let processed = matches.map((raw) => {
      // 去除末尾常见标点（句号、逗号、括号等）
      let url = raw.replace(/[.,;:!）)\]}'"]+$/, '');
      let protocol = 'https';
      if (/^ftp:/i.test(url)) protocol = 'ftp';
      else if (/^file:/i.test(url)) protocol = 'file';
      else if (/^http:/i.test(url)) protocol = 'http';

      let host = '';
      try { host = new URL(url).hostname; } catch (e) { host = ''; }

      const platform = identifyPlatform(url);

      if (stripQuery) {
        const qIdx = url.indexOf('?');
        if (qIdx > -1) url = url.substring(0, qIdx);
      }
      if (onlyDomain) {
        url = host || url;
      }

      return { url, protocol, host, platform };
    });

    // 「仅视频链接」过滤
    if (onlyVideoLinks) {
      processed = processed.filter((r) => r.platform !== null);
    }

    // 去重
    if (dedupe) {
      const seen = new Set();
      processed = processed.filter((r) => {
        const key = r.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    setResults(processed);
  };

  // 粘贴
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInputText(text);
    } catch (e) {
      // 剪贴板权限被拒，提示用户手动粘贴
      alert('无法读取剪贴板，请手动 Ctrl+V 粘贴');
    }
  };

  // 清空
  const handleClear = () => {
    setInputText('');
    setResults([]);
    setExtractedCount(0);
  };

  // 选择文件
  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setInputText(String(ev.target.result || ''));
    };
    reader.readAsText(file, 'utf-8');
    // 重置 input 以便重复选同一文件
    e.target.value = '';
  };

  // 复制全部
  const handleCopyAll = async () => {
    const text = results.map((r) => r.url).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // 回退：用临时 textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
  };

  // 导出 TXT
  const handleExportTxt = () => {
    const text = results.map((r) => r.url).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `links_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  // 仅复制视频类链接（有平台标签的）
  const handleCopyVideoLinks = async () => {
    const videoLinks = results.filter((r) => r.platform).map((r) => r.url);
    if (videoLinks.length === 0) {
      alert('未识别到可下载平台的视频链接');
      return;
    }
    const text = videoLinks.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
    alert(`已复制 ${videoLinks.length} 条视频链接到剪贴板`);
  };

  // 复制单条
  const handleCopyOne = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
  };

  const videoLinkCount = useMemo(
    () => results.filter((r) => r.platform).length,
    [results]
  );

  return (
    <div className="multiplatform-page fade-in">
      <h1 className="page-title">文本处理工具</h1>
      <p className="page-subtitle">从文本/网页源码中批量提取 URL 链接，支持 http/https/ftp/file 协议</p>

      <div className="card texttool-card fade-in">
      <div className="texttool-header">
        <h2 className="card-h2">
          <span className="card-h2-icon">🔗</span>
          链接提取
        </h2>
        <p className="texttool-desc">
          粘贴网页源码、文档或任意文本，工具会自动扫描并提取其中所有链接。可去重、去参数、提取域名，并智能识别抖音/TikTok 等视频平台。
        </p>
      </div>

      {/* 输入区 */}
      <div className="texttool-input-area">
        <div className="texttool-input-header">
          <span className="texttool-input-label">输入文本</span>
          <div className="texttool-input-actions">
            <button className="btn btn-secondary btn-sm" onClick={handlePaste}>📋 粘贴</button>
            <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current && fileInputRef.current.click()}>📂 选择文件</button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.html,.htm,.csv,.log,.json,.xml,text/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <button className="btn btn-secondary btn-sm" onClick={handleClear}>清空</button>
          </div>
        </div>
        <textarea
          className="texttool-textarea"
          placeholder="在此粘贴网页源码、文档或任意文本...&#10;工具会自动扫描并提取其中所有 http/https/ftp/file 协议的链接"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          rows={8}
        />

        {/* 选项 */}
        <div className="texttool-options">
          <label className="texttool-option">
            <input type="checkbox" checked={onlyVideoLinks} onChange={(e) => setOnlyVideoLinks(e.target.checked)} />
            <span>仅视频链接</span>
            <small className="texttool-option-hint">（抖音/TikTok/快手等支持的平台）</small>
          </label>
          <label className="texttool-option">
            <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
            <span>去除重复</span>
          </label>
          <label className="texttool-option">
            <input type="checkbox" checked={stripQuery} onChange={(e) => setStripQuery(e.target.checked)} />
            <span>去除参数</span>
            <small className="texttool-option-hint">（? 后内容）</small>
          </label>
          <label className="texttool-option">
            <input type="checkbox" checked={onlyDomain} onChange={(e) => setOnlyDomain(e.target.checked)} />
            <span>只显示域名</span>
          </label>
        </div>

        <div className="texttool-action-row">
          <button
            className="btn btn-primary texttool-extract-btn"
            onClick={handleExtract}
            disabled={!inputText.trim()}
          >
            🔍 开始提取
          </button>
        </div>
      </div>

      {/* 结果区 */}
      {results.length > 0 && (
        <div className="texttool-result-area">
          <div className="texttool-result-header">
            <div className="texttool-result-stats">
              共提取 <strong>{extractedCount}</strong> 条
              {dedupe && extractedCount > results.length && (
                <span>，去重后 <strong>{results.length}</strong> 条</span>
              )}
              {videoLinkCount > 0 && (
                <span className="texttool-video-count">（其中视频链接 {videoLinkCount} 条）</span>
              )}
            </div>
            <div className="texttool-result-actions">
              <button className="btn btn-secondary btn-sm" onClick={handleCopyAll}>📋 复制全部</button>
              <button className="btn btn-secondary btn-sm" onClick={handleExportTxt}>💾 导出 TXT</button>
              {videoLinkCount > 0 && (
                <button className="btn btn-primary btn-sm" onClick={handleCopyVideoLinks}>
                  📋 复制视频链接 ({videoLinkCount})
                </button>
              )}
            </div>
          </div>

          <div className="texttool-link-list">
            {results.map((r, i) => (
              <div key={i} className="texttool-link-item">
                <span className="texttool-link-index">{i + 1}</span>
                <span className={`texttool-link-proto proto-${r.protocol}`}>{r.protocol}</span>
                {r.platform && (
                  <span
                    className="texttool-link-platform"
                    style={{ backgroundColor: r.platform.color }}
                    title={r.platform.name}
                  >
                    {r.platform.name}
                  </span>
                )}
                <span className="texttool-link-url" title={r.url}>{r.url}</span>
                <button
                  className="texttool-link-copy"
                  onClick={() => handleCopyOne(r.url)}
                  title="复制此链接"
                >
                  📋
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 空提示：提取过但无结果 */}
      {results.length === 0 && extractedCount === 0 && inputText.trim() && null}
      {results.length === 0 && extractedCount > 0 && (
        <div className="texttool-empty">未提取到符合条件的链接，请调整选项后重试</div>
      )}
      </div>
    </div>
  );
}

export default TextTool;
