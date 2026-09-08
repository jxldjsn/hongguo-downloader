import React, { useState } from 'react';
import './ShareSoftware.css';
import { ExternalLink, Copy, Check, Sparkles, Film, Image, Music, Zap, Shield } from './icons';

// 固定下载地址（蓝奏云）
const DOWNLOAD_URL = 'https://wwbve.lanzoub.com/b00g3spmta';

// 支持的平台标签
const PLATFORM_TAGS = [
  '抖音', '快手', '小红书', 'B站', '微博', '西瓜视频',
  '皮皮虾', '火山', '微视', '全民K歌', 'YouTube', 'Instagram',
  'Twitter', 'TikTok', 'Reddit', 'A站', '虎牙', '梨视频', '好看', '美拍',
];

// 功能亮点
const FEATURES = [
  { icon: Film, title: '视频下载', desc: '高清无水印，单文件直出' },
  { icon: Image, title: '图集保存', desc: '原图批量下载，含 LivePhoto' },
  { icon: Music, title: '音频提取', desc: '一键提取视频背景音乐' },
  { icon: Zap, title: '极速解析', desc: '链接粘贴即解析，毫秒响应' },
  { icon: Shield, title: '安全纯净', desc: '本地运行，不上传任何数据' },
  { icon: Sparkles, title: '20+ 平台', desc: '主流平台全覆盖，持续增加' },
];

function ShareSoftware() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(DOWNLOAD_URL);
      setCopied(true);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = DOWNLOAD_URL;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); } catch (_) { setCopied(false); }
      document.body.removeChild(ta);
    }
    setTimeout(() => setCopied(false), 2500);
  };

  const handleOpen = () => {
    window.electronAPI.openExternalUrl(DOWNLOAD_URL);
  };

  return (
    <div className="share-page">
      {/* 背景装饰光斑 */}
      <div className="share-bg-decor">
        <span className="share-orb share-orb-1" />
        <span className="share-orb share-orb-2" />
        <span className="share-orb share-orb-3" />
        <span className="share-orb share-orb-4" />
      </div>

      <div className="share-content-wrap">
        {/* 顶部主视觉 */}
        <div className="share-hero">
          <div className="share-logo-glow">
            <div className="share-logo">⬇️</div>
          </div>
          <h1 className="share-title">抖音-TikTok 多平台</h1>
          <p className="share-slogan">全网视频 · 一键下载 · 永久免费</p>

          <div className="share-platform-tags">
            {PLATFORM_TAGS.map((name) => (
              <span key={name} className="share-tag">{name}</span>
            ))}
          </div>
        </div>

        {/* 下载地址卡片 */}
        <div className="share-download-card">
          <div className="share-download-header">
            <Sparkles size={18} />
            <span>获取下载地址</span>
          </div>

          <div className="share-url-box">
            <input
              type="text"
              className="share-url-input"
              value={DOWNLOAD_URL}
              readOnly
              onClick={(e) => e.target.select()}
            />
            <button
              type="button"
              className={`share-btn share-btn-copy${copied ? ' copied' : ''}`}
              onClick={handleCopy}
            >
              {copied ? <><Check size={16} /> 已复制</> : <><Copy size={16} /> 复制链接</>}
            </button>
            <button
              type="button"
              className="share-btn share-btn-open"
              onClick={handleOpen}
            >
              <ExternalLink size={16} /> 立即下载
            </button>
          </div>

          {copied && <div className="share-copy-tip">✓ 链接已复制，去粘贴给朋友吧！</div>}
        </div>

        {/* 功能亮点网格 */}
        <div className="share-features">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="share-feature">
                <span className="share-feature-icon"><Icon size={22} /></span>
                <div className="share-feature-text">
                  <strong>{f.title}</strong>
                  <span>{f.desc}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* 分享引导 */}
        <div className="share-cta">
          <div className="share-cta-text">
            <h3>觉得好用？分享给朋友</h3>
            <p>复制上方链接，发到微信、QQ 等聊天窗口，朋友点击即可下载安装</p>
          </div>
          <button className="share-cta-btn" onClick={handleCopy}>
            <Copy size={16} /> 一键复制链接
          </button>
        </div>
      </div>
    </div>
  );
}

export default ShareSoftware;
