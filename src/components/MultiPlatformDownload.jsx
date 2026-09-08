import React, { useState } from 'react';
import './MultiPlatformDownload.css';

// 平台真实 logo（从各平台官网 CDN 获取）
import logoDouyin from '../assets/platform-logos/douyin.png';
import logoKuaishou from '../assets/platform-logos/kuaishou.png';
import logoXiaohongshu from '../assets/platform-logos/xiaohongshu.png';
import logoBilibili from '../assets/platform-logos/bilibili.png';
import logoWeibo from '../assets/platform-logos/weibo.png';
import logoPipixia from '../assets/platform-logos/pipixia.png';
import logoXigua from '../assets/platform-logos/xigua.png';
import logoWeishi from '../assets/platform-logos/weishi.png';
import logoZuiyou from '../assets/platform-logos/zuiyou.png';
import logoHuoshan from '../assets/platform-logos/huoshan.png';
import logoQuanmin from '../assets/platform-logos/quanmin.png';
import logoLishipin from '../assets/platform-logos/lishipin.png';
import logoHuya from '../assets/platform-logos/huya.png';
import logoAcfun from '../assets/platform-logos/acfun.png';
import logoMeipai from '../assets/platform-logos/meipai.png';
import logoQuanminkge from '../assets/platform-logos/quanminkge.png';
import logoSixroom from '../assets/platform-logos/sixroom.png';
import logoHaokan from '../assets/platform-logos/haokan.png';
import logoYoutube from '../assets/platform-logos/youtube.png';

const PLATFORM_LOGOS = {
  douyin: logoDouyin,
  kuaishou: logoKuaishou,
  xiaohongshu: logoXiaohongshu,
  bilibili: logoBilibili,
  weibo: logoWeibo,
  pipixia: logoPipixia,
  xigua: logoXigua,
  weishi: logoWeishi,
  zuiyou: logoZuiyou,
  huoshan: logoHuoshan,
  quanmin: logoQuanmin,
  lishipin: logoLishipin,
  huya: logoHuya,
  acfun: logoAcfun,
  meipai: logoMeipai,
  quanminkge: logoQuanminkge,
  sixroom: logoSixroom,
  haokan: logoHaokan,
  youtube: logoYoutube,
};

/**
 * 多平台视频下载页面
 * 粘贴任意平台分享链接/口令 -> 解析 -> 显示视频/图集信息 -> 下载到下载管理器
 */
function MultiPlatformDownload({ onNavigate }) {
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState(null);
  // 清晰度选择弹窗：{ qualities: [], onSelect: (height) => void, title?: string }
  const [qualityPicker, setQualityPicker] = useState(null);

  // 批量模式
  const [batchMode, setBatchMode] = useState(false);             // 单条 / 批量 模式切换
  const [batchResults, setBatchResults] = useState([]);           // [{raw, ok, data, error, status}]
  const [batchParsing, setBatchParsing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [selectedBatchIdx, setSelectedBatchIdx] = useState(new Set()); // 勾选的索引
  const [batchDownloading, setBatchDownloading] = useState(false);

  const handleParse = async () => {
    const text = inputText.trim();
    if (!text) {
      setError('请粘贴视频链接或分享口令');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setDownloadMsg(null);

    try {
      const res = await window.electronAPI.parseVideoLink(text);
      if (res && res.success && res.data) {
        // 记录用户输入的原始链接/口令，作为下载任务的 sourceUrl（下载管理展示用）
        res.data._sourceUrl = text;
        setResult(res.data);
      } else {
        setError(res?.error || '解析失败，请检查链接是否正确');
      }
    } catch (err) {
      console.error('解析失败:', err);
      setError(err.message || '解析失败');
    } finally {
      setLoading(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setInputText(text);
        setError(null);
      }
    } catch (err) {
      console.error('粘贴失败:', err);
      setError('无法读取剪贴板，请手动粘贴');
    }
  };

  const handleClear = () => {
    setInputText('');
    setResult(null);
    setError(null);
    setDownloadMsg(null);
  };

  // 通用：按解析结果下载一条，返回 {ok, error}
  // opts: { ytdlHeight } 批量统一清晰度时传入，跳过弹窗；单条下载不传则按需弹窗
  //       { batchOptions } 批量下载时传入（{customDir, batchId, batchInfo}），实现文件夹+批次分组
  const downloadOneResult = async (data, opts = {}) => {
    if (!data) return { ok: false, error: '无数据' };
    const batchOptions = opts.batchOptions;

    // 图集
    if (data.type === 'image' && data.images && data.images.length > 0) {
      return downloadAlbumResult(data, batchOptions);
    }

    if (!data.video?.url) return { ok: false, error: '没有可下载的视频地址' };

    const platform = data.platform;
    const title = (data.title || '视频').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 50);
    const filename = `${title}.mp4`;
    const videoInfo = {
      title: data.title,
      author: data.author?.name || '',
      platform: platform,
      platformName: data.platformName,
      cover: data.cover || '',
      sourceUrl: data._sourceUrl || '',
    };

    try {
      // B站 DASH
      if (data.video.isDash && data.video.audioUrl) {
        const res = await window.electronAPI.downloadDash(
          data.video.url, data.video.audioUrl, videoInfo, platform, batchOptions
        );
        return res && res.success ? { ok: true } : { ok: false, error: res?.error || '下载失败' };
      }

      // yt-dlp（YouTube / Instagram / Twitter 等）
      if (data.video.isYtdl) {
        const qualities = data.video.qualities || [];
        let height = opts.ytdlHeight;

        // 单条下载且未指定清晰度时，按需弹窗
        if (height === undefined && qualities.length > 1) {
          return new Promise((resolve) => {
            setQualityPicker({
              qualities,
              title: data.title || '',
              onSelect: (h) => {
                setQualityPicker(null);
                resolve(startYtdlDownload(data, h, videoInfo, platform, batchOptions));
              },
              onCancel: () => {
                setQualityPicker(null);
                resolve({ ok: false, error: '已取消' });
              },
            });
          });
        }
        return await startYtdlDownload(data, height || 0, videoInfo, platform, batchOptions);
      }

      // HLS / m3u8
      if (data.video.url.includes('.m3u8')) {
        const res = await window.electronAPI.downloadM3u8(data.video.url, videoInfo, platform, batchOptions);
        return res && res.success ? { ok: true } : { ok: false, error: res?.error || '下载失败' };
      }

      // 普通视频（抖音优先无水印地址）
      const downloadUrl = data.video.urlNoWatermark || data.video.url;
      const res = await window.electronAPI.downloadFile(downloadUrl, filename, videoInfo, platform, batchOptions);
      return res && res.success ? { ok: true } : { ok: false, error: res?.error || '下载失败' };
    } catch (err) {
      console.error('下载失败:', err);
      return { ok: false, error: err.message || '下载失败' };
    }
  };

  // 图集下载
  const downloadAlbumResult = async (data, batchOptions) => {
    const platform = data.platform;
    const videoInfo = {
      title: data.title,
      author: data.author?.name || '',
      platform: platform,
      platformName: data.platformName,
      cover: data.cover || '',
      sourceUrl: data._sourceUrl || '',
    };
    const items = data.images.map((img) => {
      const list = [];
      if (img.url) list.push({ url: img.url, type: 'image', ext: '.jpg' });
      if (img.livePhotoUrl) list.push({ url: img.livePhotoUrl, type: 'video', ext: '.mp4' });
      return list;
    }).flat();
    if (data.music && data.music.url) items.push({ url: data.music.url, type: 'audio', ext: '.mp3' });
    try {
      const res = await window.electronAPI.downloadAlbum(items, videoInfo, platform, batchOptions);
      return res && res.success ? { ok: true } : { ok: false, error: res?.error || '下载失败' };
    } catch (err) {
      return { ok: false, error: err.message || '下载失败' };
    }
  };

  // yt-dlp 下载：height=0 表示最高画质
  const startYtdlDownload = async (data, height, videoInfo, platform, batchOptions) => {
    if (!data || !data.video?.url) return { ok: false, error: '无视频地址' };
    try {
      const res = await window.electronAPI.downloadYtdl(
        data.video.url, videoInfo, platform, height || 0, batchOptions
      );
      return res && res.success ? { ok: true } : { ok: false, error: res?.error || '下载失败' };
    } catch (err) {
      return { ok: false, error: err.message || '下载失败' };
    }
  };

  // 单条下载入口（兼容现有按钮）
  const handleDownloadVideo = async () => {
    if (!result) return;
    setDownloading(true);
    setDownloadMsg(null);
    const r = await downloadOneResult(result);
    setDownloadMsg(r.ok
      ? { type: 'success', text: '已添加到下载队列，请前往下载管理查看' }
      : { type: 'error', text: r.error || '下载失败' });
    setDownloading(false);
    // 下载提交成功后立即跳转到下载管理页「下载中」标签
    if (r.ok && typeof onNavigate === 'function') {
      onNavigate('download', 'downloading');
    }
  };

  // ===== 批量模式 =====

  // 切换模式时清空批量状态
  const handleModeSwitch = (mode) => {
    setBatchMode(mode === 'batch');
    setBatchResults([]);
    setSelectedBatchIdx(new Set());
    setBatchProgress({ current: 0, total: 0 });
    setError(null);
    setDownloadMsg(null);
  };

  // 批量解析：按行拆分，串行解析
  const handleBatchParse = async () => {
    const text = inputText.trim();
    if (!text) {
      setError('请粘贴视频链接或分享口令，一行一个');
      return;
    }
    // 按行拆分，去空行、去重
    const lines = Array.from(new Set(
      text.split('\n').map(l => l.trim()).filter(Boolean)
    ));
    if (lines.length === 0) {
      setError('未识别到有效链接');
      return;
    }

    setBatchParsing(true);
    setError(null);
    setBatchResults([]);
    setSelectedBatchIdx(new Set());
    setBatchProgress({ current: 0, total: lines.length });

    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      setBatchProgress({ current: i + 1, total: lines.length });
      try {
        const res = await window.electronAPI.parseVideoLink(raw);
        if (res && res.success && res.data) {
          res.data._sourceUrl = raw;
          results.push({ raw, ok: true, data: res.data, status: 'pending' });
        } else {
          results.push({ raw, ok: false, error: res?.error || '解析失败', status: 'fail' });
        }
      } catch (err) {
        results.push({ raw, ok: false, error: err.message || '解析失败', status: 'fail' });
      }
      // 实时更新列表
      setBatchResults([...results]);
      // 串行间隔，降低风控概率
      if (i < lines.length - 1) await new Promise(r => setTimeout(r, 400));
    }

    // 默认勾选所有成功项
    setSelectedBatchIdx(new Set(results.map((r, idx) => r.ok ? idx : null).filter(x => x !== null)));
    setBatchParsing(false);
  };

  // 批量勾选切换
  const toggleBatchSelect = (idx) => {
    setSelectedBatchIdx(prev => {
      const s = new Set(prev);
      if (s.has(idx)) s.delete(idx); else s.add(idx);
      return s;
    });
  };

  const toggleBatchSelectAll = () => {
    const okIdx = batchResults.map((r, idx) => r.ok ? idx : null).filter(x => x !== null);
    if (selectedBatchIdx.size === okIdx.length) {
      setSelectedBatchIdx(new Set());
    } else {
      setSelectedBatchIdx(new Set(okIdx));
    }
  };

  // 批量下载
  const handleBatchDownload = async () => {
    const picked = Array.from(selectedBatchIdx).sort((a, b) => a - b)
      .map(idx => batchResults[idx]).filter(Boolean);
    if (picked.length === 0) {
      setError('请勾选要下载的项');
      return;
    }

    // 检查是否有 ytdl 视频且多清晰度：若有，统一弹一次清晰度选择
    const ytdlItems = picked.filter(r => r.ok && r.data && r.data.video && r.data.video.isYtdl
      && (r.data.video.qualities || []).length > 1);
    let unifiedHeight; // undefined = 各自最高；number = 统一高度
    if (ytdlItems.length > 0) {
      // 用第一个 ytdl 视频的 qualities 作为代表（各视频清晰度不一，不强制交集）
      const repQualities = ytdlItems[0].data.video.qualities;
      unifiedHeight = await new Promise((resolve) => {
        setQualityPicker({
          qualities: repQualities,
          title: `批量下载 · 共 ${ytdlItems.length} 个 YouTube/yt-dlp 视频`,
          isBatch: true,
          onSelect: (h) => { setQualityPicker(null); resolve(h); },
          onCancel: () => { setQualityPicker(null); resolve('__cancel__'); },
        });
      });
      if (unifiedHeight === '__cancel__') return; // 用户取消
    }

    setBatchDownloading(true);
    setError(null);
    // 统一批次：选中的视频进入同一个文件夹 + 下载管理按批分组
    const batchId = `multi_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const folderName = `批量下载--${new Date().toISOString().slice(0, 10)}`;
    const batchInfo = { nickname: folderName, authorName: '批量下载', profileUrl: '', avatar: '', platform: 'multiplatform', folderName };
    const batchOptions = { customDir: folderName, batchId, batchInfo };

    const newResults = [...batchResults];
    for (let i = 0; i < picked.length; i++) {
      const item = picked[i];
      const idx = batchResults.indexOf(item);
      newResults[idx] = { ...item, status: 'downloading' };
      setBatchResults([...newResults]);

      const opts = { batchOptions };
      if (item.data.video && item.data.video.isYtdl && unifiedHeight !== undefined) {
        opts.ytdlHeight = unifiedHeight;
      }
      const r = await downloadOneResult(item.data, opts);
      newResults[idx] = { ...item, status: r.ok ? 'done' : 'fail', error: r.ok ? null : r.error };
      setBatchResults([...newResults]);
      if (i < picked.length - 1) await new Promise(res => setTimeout(res, 300));
    }
    setBatchDownloading(false);
    setDownloadMsg({ type: 'success', text: `批量下载已提交，请前往下载管理查看` });
    // 批量下载提交后跳转到下载管理页「下载中」标签
    if (typeof onNavigate === 'function') {
      onNavigate('download', 'downloading');
    }
  };

  // 下载图集（多张图片）——单条模式入口
  // 下载图集（多张图片）--单条模式入口，复用 downloadOneResult
  const handleDownloadAlbum = async () => {
    if (!result || !result.images || result.images.length === 0) {
      setDownloadMsg({ type: 'error', text: '没有可下载的图片' });
      return;
    }
    setDownloading(true);
    setDownloadMsg(null);
    const r = await downloadOneResult(result);
    setDownloadMsg(r.ok
      ? { type: 'success', text: '已添加到下载队列，请前往下载管理查看' }
      : { type: 'error', text: r.error || '下载失败' });
    setDownloading(false);
  };

  // 文件大小格式化
  const formatFileSize = (bytes) => {
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'GB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + 'KB';
    return bytes + 'B';
  };

  // 视频编码归一化显示
  const formatVcodec = (vc) => {
    if (!vc) return '';
    const v = vc.toLowerCase();
    if (v.includes('av01') || v.includes('av1')) return 'AV1';
    if (v.includes('vp9')) return 'VP9';
    if (v.includes('vp09') || v.includes('vp8')) return 'VP9';
    if (v.includes('hev1') || v.includes('hvc1') || v.includes('hevc') || v.includes('h265')) return 'HEVC';
    if (v.includes('avc1') || v.includes('h264') || v.includes('x264')) return 'H264';
    return vc.split('.')[0].toUpperCase();
  };

  // 判断某清晰度是否推荐（最高画质 或 1080p）
  const isRecommended = (q, qualities) => {
    if (!q) return false;
    const maxHeight = qualities.reduce((m, x) => Math.max(m, x.height || 0), 0);
    if (q.height === maxHeight) return true;
    if (q.height === 1080) return true;
    return false;
  };

  const formatNumber = (num) => {
    if (!num) return '0';
    if (num >= 10000) return (num / 10000).toFixed(1) + 'w';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  };

  // 时长格式化（秒 -> mm:ss 或 h:mm:ss），yt-dlp 站点（YouTube/Instagram 等）duration 单位是秒
  const formatDuration = (sec) => {
    sec = Math.round(Number(sec) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="multiplatform-page fade-in">
      <h1 className="page-title">多平台下载</h1>
      <p className="page-subtitle">粘贴任意平台视频链接或分享口令，自动解析并下载</p>

      {/* 模式切换 */}
      <div className="mp-mode-tabs">
        <button
          className={`mp-mode-tab${!batchMode ? ' active' : ''}`}
          onClick={() => handleModeSwitch('single')}
        >单条下载</button>
        <button
          className={`mp-mode-tab${batchMode ? ' active' : ''}`}
          onClick={() => handleModeSwitch('batch')}
        >批量下载（一行一个）</button>
      </div>

      {/* 输入区 */}
      <div className="card mp-input-card">
        <div className="mp-input-header">
          <span className="mp-input-label">{batchMode ? '链接 / 分享口令（一行一个）' : '链接 / 分享口令'}</span>
          <div className="mp-input-actions">
            <button className="btn btn-secondary btn-sm" onClick={handlePaste}>📋 粘贴</button>
            <button className="btn btn-secondary btn-sm" onClick={handleClear}>清空</button>
          </div>
        </div>
        <textarea
          className="mp-textarea"
          placeholder={batchMode
            ? '一行一个链接或分享口令，例如：\nhttps://www.douyin.com/video/xxx\nhttps://www.bilibili.com/video/BVxxx\nhttps://youtu.be/xxx'
            : '在此粘贴分享文本，例如：\n7.07 Q@e.gy 12/15 t-aAA hAA 这段好有趣 ... https://v.douyin.com/xxxxx/ ...\n或直接粘贴网页链接：https://www.bilibili.com/video/BVxxxxx'}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          rows={batchMode ? 6 : 4}
        />
        <div className="mp-parse-row">
          <button
            className="btn btn-primary mp-parse-btn"
            onClick={batchMode ? handleBatchParse : handleParse}
            disabled={(batchMode ? batchParsing : loading) || !inputText.trim()}
          >
            {batchMode ? (
              batchParsing
                ? <><span className="mp-spinner"></span> 解析中 {batchProgress.current}/{batchProgress.total}</>
                : '🔍 批量解析'
            ) : (
              loading
                ? <><span className="mp-spinner"></span> 解析中...</>
                : '🔍 解析链接'
            )}
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="card mp-error-card">
          <span className="mp-error-icon">⚠️</span>
          <span className="mp-error-text">{error}</span>
        </div>
      )}

      {/* 下载提示 */}
      {downloadMsg && (
        <div className={`card mp-msg-card mp-msg-${downloadMsg.type}`}>
          <span className="mp-msg-icon">{downloadMsg.type === 'success' ? '✅' : '❌'}</span>
          <span className="mp-msg-text">{downloadMsg.text}</span>
        </div>
      )}

      {/* 解析结果 - 单条模式 */}
      {!batchMode && result && (
        <div className="card mp-result-card fade-in">
          {/* 平台标识 */}
          <div className="mp-result-header">
            <span className="mp-platform-badge">{result.platformName || result.platform}</span>
            <span className={`mp-type-badge mp-type-${result.type}`}>
              {result.type === 'image' ? '🖼️ 图集' : '🎬 视频'}
            </span>
          </div>

          {/* 视频信息 */}
          <div className="mp-video-info">
            {result.cover && (
              <div className="mp-cover">
                <img src={result.cover} alt="封面" onError={(e) => e.target.style.display = 'none'} />
              </div>
            )}
            <div className="mp-info-body">
              <h3 className="mp-title">{result.title || '无标题'}</h3>
              {result.author && (
                <div className="mp-author">
                  {result.author.avatar && (
                    <img className="mp-avatar" src={result.author.avatar} alt="" onError={(e) => e.target.style.display = 'none'} />
                  )}
                  <span>{result.author.name}</span>
                </div>
              )}

              {/* 统计数据 */}
              {result.statistics && (
                <div className="mp-stats">
                  {result.statistics.digg !== undefined && (
                    <span className="mp-stat">👍 {formatNumber(result.statistics.digg)}</span>
                  )}
                  {result.statistics.comment !== undefined && (
                    <span className="mp-stat">💬 {formatNumber(result.statistics.comment)}</span>
                  )}
                  {result.statistics.share !== undefined && (
                    <span className="mp-stat">🔗 {formatNumber(result.statistics.share)}</span>
                  )}
                  {result.statistics.liked !== undefined && (
                    <span className="mp-stat">❤️ {formatNumber(result.statistics.liked)}</span>
                  )}
                  {result.statistics.collected !== undefined && (
                    <span className="mp-stat">⭐ {formatNumber(result.statistics.collected)}</span>
                  )}
                  {result.statistics.view !== undefined && (
                    <span className="mp-stat">▶️ {formatNumber(result.statistics.view)}</span>
                  )}
                  {result.statistics.reposts !== undefined && (
                    <span className="mp-stat">🔁 {formatNumber(result.statistics.reposts)}</span>
                  )}
                  {result.statistics.attitudes !== undefined && (
                    <span className="mp-stat">😍 {formatNumber(result.statistics.attitudes)}</span>
                  )}
                </div>
              )}

              {/* 视频详情 */}
              {result.type === 'video' && result.video && (
                <div className="mp-video-detail">
                  {result.video.width > 0 && result.video.height > 0 && (
                    <span className="mp-detail-item">分辨率: {result.video.width}×{result.video.height}</span>
                  )}
                  {result.video.duration > 0 && (
                    <span className="mp-detail-item">时长: {(result.platform === 'youtube' || result.platform === 'ytdl') ? formatDuration(result.video.duration) : Math.round(result.video.duration / 1000) + 's'}</span>
                  )}
                  {result.video.quality && (
                    <span className="mp-detail-item">清晰度: {result.video.quality}</span>
                  )}
                  {result.video.isDash && (
                    <span className="mp-detail-item mp-detail-warn">B站高清DASH（下载时自动合并视频+音频）</span>
                  )}
                  {result.video.isYtdl && (
                    <span className="mp-detail-item mp-detail-warn">{result.platformName || 'yt-dlp'}（由 yt-dlp 下载并自动合并视频+音频）</span>
                  )}
                </div>
              )}

              {/* 图集详情 */}
              {result.type === 'image' && result.images && (
                <div className="mp-album-detail">
                  共 {result.images.length} 张图片
                  {result.images.some(img => img.livePhotoUrl) && (
                    <span className="mp-detail-item mp-livephoto">（含LivePhoto）</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 图集预览 */}
          {result.type === 'image' && result.images && result.images.length > 0 && (
            <div className="mp-album-preview">
              {result.images.map((img, idx) => (
                <div key={idx} className="mp-album-item">
                  <img
                    src={img.url}
                    alt={`图${idx + 1}`}
                    onError={(e) => { e.target.src = ''; e.target.alt = '加载失败'; }}
                  />
                  {img.livePhotoUrl && <span className="mp-livephoto-badge">Live</span>}
                </div>
              ))}
            </div>
          )}

          {/* 下载按钮 */}
          <div className="mp-download-actions">
            {result.type === 'video' && (
              <button
                className="btn btn-primary mp-download-btn"
                onClick={handleDownloadVideo}
                disabled={downloading}
              >
                {downloading ? '⏳ 下载中...' : '⬇️ 下载视频'}
              </button>
            )}
            {result.type === 'image' && (
              <button
                className="btn btn-primary mp-download-btn"
                onClick={handleDownloadAlbum}
                disabled={downloading}
              >
                {downloading ? '⏳ 下载中...' : `⬇️ 下载图集 (${result.images.length}张)`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 批量解析结果 - 批量模式 */}
      {batchMode && (batchResults.length > 0 || batchParsing) && (
        <div className="card mp-batch-card fade-in">
          <div className="mp-batch-toolbar">
            <label className="mp-batch-select-all">
              <input
                type="checkbox"
                checked={selectedBatchIdx.size > 0 && selectedBatchIdx.size === batchResults.filter(r => r.ok).length}
                onChange={toggleBatchSelectAll}
                disabled={batchParsing || batchDownloading || batchResults.filter(r => r.ok).length === 0}
              />
              <span>全选</span>
            </label>
            <span className="mp-batch-count">
              共 {batchResults.length} 条 · 成功 {batchResults.filter(r => r.ok).length} · 已选 {selectedBatchIdx.size}
            </span>
            <button
              className="btn btn-primary mp-batch-download-btn"
              onClick={handleBatchDownload}
              disabled={batchDownloading || selectedBatchIdx.size === 0}
            >
              {batchDownloading
                ? <><span className="mp-spinner"></span> 下载中...</>
                : `⬇️ 下载选中 (${selectedBatchIdx.size})`}
            </button>
          </div>

          <div className="mp-batch-list">
            {batchResults.map((r, idx) => {
              const ok = r.ok;
              const data = r.data || {};
              const logo = PLATFORM_LOGOS[data.platform] || '';
              return (
                <div key={idx} className={`mp-batch-item${ok ? '' : ' is-fail'}${r.status === 'downloading' ? ' is-downloading' : ''}${r.status === 'done' ? ' is-done' : ''}`}>
                  <div className="mp-batch-check">
                    <input
                      type="checkbox"
                      checked={selectedBatchIdx.has(idx)}
                      onChange={() => toggleBatchSelect(idx)}
                      disabled={!ok || r.status === 'downloading' || r.status === 'done'}
                    />
                  </div>
                  <div className="mp-batch-cover">
                    {data.cover
                      ? <img src={data.cover} alt="" onError={(e) => e.target.style.display = 'none'} />
                      : <span className="mp-batch-cover-fallback">{ok ? (data.type === 'image' ? '🖼️' : '🎬') : '⚠️'}</span>}
                  </div>
                  <div className="mp-batch-info">
                    <div className="mp-batch-info-top">
                      {logo
                        ? <img className="mp-batch-platform-logo" src={logo} alt="" onError={(e) => e.target.style.display = 'none'} />
                        : <span className="mp-batch-platform-badge">{data.platformName || (ok ? data.platform : '?')}</span>}
                      <span className="mp-batch-platform-name">{data.platformName || (ok ? data.platform : '解析失败')}</span>
                      {ok && (
                        <span className={`mp-batch-type-badge mp-type-${data.type}`}>
                          {data.type === 'image' ? '🖼️ 图集' : '🎬 视频'}
                        </span>
                      )}
                      <span className={`mp-batch-status mp-batch-status-${r.status}`}>
                        {r.status === 'pending' && '⏳ 待下载'}
                        {r.status === 'downloading' && '⏬ 下载中'}
                        {r.status === 'done' && '✅ 已加入队列'}
                        {r.status === 'fail' && '❌ 失败'}
                      </span>
                    </div>
                    <div className="mp-batch-title" title={ok ? (data.title || '无标题') : r.raw}>
                      {ok ? (data.title || '无标题') : r.raw}
                    </div>
                    <div className="mp-batch-meta">
                      {ok && data.author?.name && <span>👤 {data.author.name}</span>}
                      {ok && data.type === 'image' && data.images?.length > 0 && <span>🖼️ {data.images.length}张</span>}
                      {ok && data.type === 'video' && data.video?.duration > 0 && (
                        <span>⏱️ {(data.platform === 'youtube' || data.platform === 'ytdl') ? formatDuration(data.video.duration) : Math.round(data.video.duration / 1000) + 's'}</span>
                      )}
                      {!ok && r.error && <span className="mp-batch-error-text">原因：{r.error}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 支持平台列表 */}
      {!batchMode && !result && !loading && !error && (
        <div className="card mp-platforms-card">
          <h3 className="mp-section-title">支持的平台（点击跳转官网）</h3>
          <div className="mp-platforms-grid">
            {SUPPORTED_PLATFORMS.map(p => (
              <div
                key={p.code}
                className="mp-platform-chip mp-platform-clickable"
                title={`点击打开 ${p.name} 官网`}
                onClick={() => p.url && window.electronAPI.openExternalUrl(p.url)}
              >
                <div className="mp-platform-head">
                  {PLATFORM_LOGOS[p.code] ? (
                    <img
                      className="mp-platform-logo"
                      src={PLATFORM_LOGOS[p.code]}
                      alt={p.name}
                      onError={(e) => {
                        // logo 加载失败时回退到彩色首字
                        e.target.outerHTML = `<span class="mp-platform-logo mp-platform-logo-fallback" style="background:${p.color || '#888'}">${p.initial || p.name.charAt(0)}</span>`;
                      }}
                    />
                  ) : (
                    <span
                      className="mp-platform-logo mp-platform-logo-fallback"
                      style={{ background: p.color || '#888' }}
                    >
                      {p.initial || p.name.charAt(0)}
                    </span>
                  )}
                  <div className="mp-platform-text">
                    <span className="mp-platform-name">{p.name}</span>
                    <span className="mp-platform-features">{p.features.join(' / ')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 清晰度选择弹窗 */}
      {qualityPicker && (
        <div className="mp-quality-overlay" onClick={() => qualityPicker.onCancel ? qualityPicker.onCancel() : setQualityPicker(null)}>
          <div className="mp-quality-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mp-quality-header">
              <h3>{qualityPicker.isBatch ? '批量下载 · 统一选择清晰度' : '选择清晰度'}</h3>
              <button className="mp-quality-close" onClick={() => qualityPicker.onCancel ? qualityPicker.onCancel() : setQualityPicker(null)}>✕</button>
            </div>
            <p className="mp-quality-tip">
              {qualityPicker.isBatch
                ? `选中项中有 ${qualityPicker.qualities?.length || 0} 个清晰度可选，所有 YouTube / yt-dlp 视频将统一使用该清晰度下载`
                : `${result?.platformName || 'yt-dlp'} · 选「最高画质」默认下载最高分辨率（1080p 及以上由 ffmpeg 合并音视频）`}
            </p>
            {qualityPicker.title && !qualityPicker.isBatch && (
              <p className="mp-quality-title-line" title={qualityPicker.title}>{qualityPicker.title}</p>
            )}
            <div className="mp-quality-list">
              <button
                className="mp-quality-item mp-quality-item-top"
                onClick={() => qualityPicker.onSelect(0)}
              >
                <span className="mp-quality-name">
                  最高画质
                  <span className="mp-quality-recommend">推荐</span>
                </span>
                <span className="mp-quality-desc">自动选最佳视频+音频流</span>
              </button>
              {qualityPicker.qualities.map((q) => {
                const recommend = isRecommended(q, qualityPicker.qualities);
                const vc = formatVcodec(q.vcodec);
                const size = formatFileSize(q.filesize);
                return (
                  <button
                    key={q.height}
                    className={`mp-quality-item${recommend ? ' is-recommend' : ''}`}
                    onClick={() => qualityPicker.onSelect(q.height)}
                  >
                    <span className="mp-quality-name">
                      {q.label}
                      {q.fps > 30 && <span className="mp-quality-badge">{q.fps}fps</span>}
                      {recommend && <span className="mp-quality-recommend">推荐</span>}
                    </span>
                    <span className="mp-quality-meta">
                      {q.ext && q.ext.toUpperCase()}
                      {vc && ` · ${vc}`}
                      {q.isCombined ? ' · 含音频' : ' · 视频+音频合并'}
                      {size && ` · ~${size}`}
                    </span>
                  </button>
                );
              })}
            </div>
            {qualityPicker.onCancel && (
              <div className="mp-quality-footer">
                <button className="btn btn-secondary" onClick={() => qualityPicker.onCancel()}>取消</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 支持的平台列表
// color: 平台品牌色（用于 logo 圆形背景），initial: logo 中显示的首字
const SUPPORTED_PLATFORMS = [
  { code: 'douyin', name: '抖音', features: ['视频', '图集', '去水印'], url: 'https://www.douyin.com/', color: '#161823', initial: '抖' },
  { code: 'kuaishou', name: '快手', features: ['视频', '图集'], url: 'https://www.kuaishou.com/', color: '#FF4906', initial: '快' },
  { code: 'xiaohongshu', name: '小红书', features: ['视频', '图集', 'LivePhoto'], url: 'https://www.xiaohongshu.com/', color: '#FF2442', initial: '红' },
  { code: 'bilibili', name: '哔哩哔哩', features: ['视频'], url: 'https://www.bilibili.com/', color: '#FB7299', initial: 'B' },
  { code: 'weibo', name: '微博', features: ['视频', '图集'], url: 'https://weibo.com/', color: '#E6162D', initial: '微' },
  { code: 'pipixia', name: '皮皮虾', features: ['视频', '图集'], url: 'https://h5.pipix.com/', color: '#FF8226', initial: '皮' },
  { code: 'xigua', name: '西瓜视频', features: ['视频'], url: 'https://www.ixigua.com/', color: '#F04142', initial: '西' },
  { code: 'weishi', name: '微视', features: ['视频'], url: 'https://weishi.qq.com/', color: '#12B7F5', initial: '视' },
  { code: 'zuiyou', name: '最右', features: ['视频'], url: 'http://www.izuiyou.com/', color: '#FF5C8D', initial: '右' },
  { code: 'huoshan', name: '火山', features: ['视频'], url: 'https://www.huoshan.com/', color: '#FF3E45', initial: '火' },
  { code: 'quanmin', name: '度小视', features: ['视频'], url: 'https://quanmin.baidu.com/', color: '#2932E1', initial: '度' },
  { code: 'lishipin', name: '梨视频', features: ['视频'], url: 'https://www.pearvideo.com/', color: '#00B38A', initial: '梨' },
  { code: 'huya', name: '虎牙', features: ['视频'], url: 'https://www.huya.com/', color: '#FFA800', initial: '虎' },
  { code: 'acfun', name: 'A站', features: ['视频'], url: 'https://www.acfun.cn/', color: '#FD4C5D', initial: 'A' },
  { code: 'meipai', name: '美拍', features: ['视频'], url: 'https://www.meipai.com/', color: '#FF4E8C', initial: '美' },
  { code: 'quanminkge', name: '全民K歌', features: ['音频', '视频'], url: 'https://kg.qq.com/', color: '#31C27C', initial: 'K' },
  { code: 'sixroom', name: '六间房', features: ['视频'], url: 'https://v.6.cn/', color: '#5C6BC0', initial: '六' },
  { code: 'haokan', name: '好看视频', features: ['视频'], url: 'https://haokan.baidu.com/', color: '#2932E1', initial: '好' },
  { code: 'youtube', name: 'YouTube', features: ['视频'], url: 'https://www.youtube.com/', color: '#FF0000', initial: '▶' },
  // yt-dlp 通用：未在 19 个原生平台列表中的任意链接都走这里
  // （Instagram / Twitter / TikTok 国际版 / Reddit / Facebook 等 1000+ 站点，需代理）
  { code: 'ytdl', name: 'yt-dlp 通用', features: ['视频', '图集'], url: 'https://github.com/yt-dlp/yt-dlp', color: '#5C2D91', initial: 'y' },
];

export default MultiPlatformDownload;
