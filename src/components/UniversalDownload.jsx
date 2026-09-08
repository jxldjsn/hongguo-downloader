import React, { useState, useEffect } from 'react';
import { dispatchResource, upsertResource } from '../utils/downloadUi.mjs';
import './UniversalDownload.css';
import { Download, Copy, X, Link2, Zap, Film, Image, Music, Radio, Layers, Search, Trash2 } from './icons';

// 资源类型中文名（嗅探到的分类）
const TYPE_LABELS = {
  video: '视频',
  audio: '音频',
  image: '图片',
  m3u8: 'HLS 流',
  dash: 'DASH 清单',
  m3u8_seg: '分片',
  video_dash: '视频流',
  audio_dash: '音频流',
};

const TYPE_ICONS = {
  video: <Film size={15} />,
  audio: <Music size={15} />,
  image: <Image size={15} />,
  m3u8: <Radio size={15} />,
  dash: <Zap size={15} />,
  m3u8_seg: <Layers size={15} />,
  video_dash: <Film size={15} />,
  audio_dash: <Music size={15} />,
};

// 从 URL 提取可读文件名（去 query/hash，取最后一段）
function nameFromUrl(url, ext) {
  const u = String(url || '').split('?')[0].split('#')[0];
  const seg = u.split('/').filter(Boolean).pop() || 'resource';
  let name = decodeURIComponent(seg).replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 80) || 'resource';
  // 若没有期望扩展名则补上
  if (ext && !name.toLowerCase().endsWith(ext)) {
    name = name.includes('.') ? `${name.split('.')[0]}.${ext}` : `${name}.${ext}`;
  }
  return name;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function UniversalDownload({ onNavigate }) {
  const [tab, setTab] = useState('sniff'); // sniff(网页嗅探) / cat(猫抓方案)

  // ===== 网页嗅探 =====
  const [sniffUrl, setSniffUrl] = useState('');
  const [sniffing, setSniffing] = useState(false);
  const [sniffStatus, setSniffStatus] = useState('');
  const [resources, setResources] = useState([]);
  const [filter, setFilter] = useState('all');
  const [copiedMsg, setCopiedMsg] = useState('');

  // ===== 猫抓方案（浏览器播放截取）=====
  const [catUrl, setCatUrl] = useState('');
  const [catBrowserOn, setCatBrowserOn] = useState(false);
  const [catStatus, setCatStatus] = useState('');
  const [catTitle, setCatTitle] = useState('');
  const [catMsg, setCatMsg] = useState(null);
  const [chosenVideo, setChosenVideo] = useState(null); // 用户选定为「视频轨」的流
  const [chosenAudio, setChosenAudio] = useState(null); // 用户选定为「音频轨」的流
  const [catCopied, setCatCopied] = useState('');

  // ===== B 站完整流解析（不依赖播放器，纯 HTTP）=====
  const [biliParsing, setBiliParsing] = useState(false);
  const [biliStreams, setBiliStreams] = useState(null); // { title, video[], audio[], needLogin }
  const [biliQuality, setBiliQuality] = useState('');     // 选中的清晰度 id
  const [biliError, setBiliError] = useState('');

  // 恢复到已运行状态（例如从其他页面跳回来时嗅探窗口还开着）
  useEffect(() => {
    window.electronAPI.sniffStatus().then((r) => {
      if (r && r.running) setSniffing(true);
    }).catch(() => {});
    return () => {
      // 页面卸载时订阅自动释放（ipcRenderer 监听在 preload 里按回调移除）
    };
  }, []);

  // 订阅主进程推送
  useEffect(() => {
    const offResource = window.electronAPI.onSniffResource((res) => {
      if (!res || !res.url) return;
      setResources((prev) => upsertResource(prev, res).slice(-600));
    });
    const offStatus = window.electronAPI.onSniffStatus((text) => setSniffStatus(text));
    const offStopped = window.electronAPI.onSniffStopped(() => {
      setSniffing(false);
      setCatBrowserOn(false);
      setSniffStatus('嗅探已停止（窗口已关闭）');
      setCatStatus('浏览器已关闭');
    });
    return () => {
      offResource();
      offStatus();
      offStopped();
    };
  }, []);

  const startSniff = async () => {
    const url = sniffUrl.trim();
    if (!url) { setSniffStatus('请输入要嗅探的网址'); return; }
    setResources([]);
    setSniffStatus('正在打开嗅探窗口…');
    const r = await window.electronAPI.sniffStart(url);
    if (r && r.ok) {
      setSniffing(true);
      setSniffStatus(r.already ? '嗅探窗口已打开，继续捕获中' : '嗅探窗口已打开：在窗口里播放/翻页，资源会实时出现在下方列表');
    } else {
      setSniffStatus((r && r.error) || '打开嗅探窗口失败');
    }
  };

  const stopSniff = async () => {
    await window.electronAPI.sniffStop();
    setSniffing(false);
    setSniffStatus('嗅探已停止');
  };

  const clearSniff = () => {
    setResources([]);
  };

  // 过滤后的资源
  const filtered = resources.filter((r) => filter === 'all' || r.type === filter);

  // 拼接下载用请求头（页面 URL 当 Referer，防防盗链）
  const buildHeaders = (res) => {
    const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' };
    if (res && res.pageUrl) h['Referer'] = res.pageUrl;
    return h;
  };

  const resourceDispatchConfig = (res) => {
    let ext = 'mp4';
    if (res.type === 'image') ext = 'jpg';
    else if (res.type === 'audio') ext = 'mp3';
    else if (res.type === 'm3u8_seg') ext = res.url.includes('.ts') ? 'ts' : 'm4s';
    else if (res.type === 'video_dash' || res.type === 'audio_dash') ext = 'm4s';
    const filename = nameFromUrl(res.url, ext);
    return {
      filename,
      videoInfo: { desc: filename, title: filename, platform: 'generic', platformName: '通用' },
      platform: 'generic',
      options: { headers: buildHeaders(res) },
    };
  };

  // 单个和批量下载共用同一套路由，避免 DASH/HLS 在两个入口行为不一致。
  const downloadOne = async (res) => {
    try {
      await dispatchResource(res, window.electronAPI, resourceDispatchConfig(res));
      if (typeof onNavigate === 'function') onNavigate('download', 'downloading');
    } catch (e) {
      console.error('下载失败:', e);
      setCopiedMsg('下载失败：' + (e.message || ''));
      setTimeout(() => setCopiedMsg(''), 2500);
    }
  };

  // 一键下载当前过滤后的全部资源
  const downloadAll = async () => {
    let accepted = 0;
    let failed = 0;
    for (const res of filtered) {
      try {
        await dispatchResource(res, window.electronAPI, resourceDispatchConfig(res));
        accepted += 1;
      } catch (e) {
        failed += 1;
        console.warn('批量下载跳过失败项:', res.url, e.message);
      }
    }
    if (failed > 0) {
      setCopiedMsg(accepted > 0
        ? `已添加 ${accepted} 项，${failed} 项添加失败`
        : '所有资源均未能加入下载队列');
      setTimeout(() => setCopiedMsg(''), 3000);
    }
    if (accepted > 0 && typeof onNavigate === 'function') onNavigate('download', 'downloading');
  };

  const copyUrl = async (u) => {
    try {
      await window.electronAPI.copyText(u);
      setCopiedMsg('已复制地址');
      setTimeout(() => setCopiedMsg(''), 1600);
    } catch (e) { /* ignore */ }
  };

  // ===== 猫抓方案（浏览器播放截取 + 音视频流合成）=====
  // 打开嗅探浏览器 -> 在窗口里播放视频 -> 自动截取视频流/音频流（video_dash/audio_dash）、
  // m3u8 播放列表、mpd 清单 -> 一键合并下载。
  // 截取到的流与「网页嗅探」标签共用同一个嗅探窗口与资源列表（resources）。

  // 从 resources 中筛出流媒体资源（排除图片/普通音频文件，保留可合并的流）
  const catStreams = resources.filter((r) =>
    r.type === 'video_dash' || r.type === 'audio_dash' || r.type === 'm3u8' || r.type === 'dash'
  );

  // 自动配对：默认取最新一组视频轨 + 音频轨（同一页面播放的 DASH 流）
  const autoVideo = chosenVideo || [...catStreams].reverse().find((r) => r.type === 'video_dash') || null;
  const autoAudio = chosenAudio || [...catStreams].reverse().find((r) => r.type === 'audio_dash') || null;

  const openCatBrowser = async () => {
    const url = catUrl.trim();
    if (!url) { setCatStatus('请输入要播放的网页地址'); return; }
    setCatMsg(null);
    setChosenVideo(null);
    setChosenAudio(null);
    setCatStatus('正在打开浏览器窗口…');
    const r = await window.electronAPI.sniffStart(url);
    if (r && r.ok) {
      setCatBrowserOn(true);
      setCatStatus(r.already ? '浏览器已打开，继续截取中' : '浏览器已打开：在窗口里播放视频，视频流/音频流会被自动截取');
    } else {
      setCatStatus((r && r.error) || '打开浏览器失败');
    }
  };

  const closeCatBrowser = async () => {
    await window.electronAPI.sniffStop();
    setCatBrowserOn(false);
    setCatStatus('已关闭浏览器');
  };

  // 选定某条流作为视频轨 / 音频轨（用于手工配对）
  const chooseAs = (res, role) => {
    if (role === 'video') setChosenVideo(res);
    else setChosenAudio(res);
    setCatMsg(null);
  };

  // 合并下载当前配对（视频轨 + 音频轨）
  const mergeDashPair = async () => {
    const v = autoVideo;
    const a = autoAudio;
    if (!v || !a) { setCatMsg({ type: 'error', text: '尚未截取到可配对的视频流/音频流，请先在浏览器窗口里播放视频' }); return; }
    if (v.url === a.url) { setCatMsg({ type: 'error', text: '视频轨与音频轨地址相同，无法合并' }); return; }
    setCatMsg(null);
    const title = catTitle.trim() || nameFromUrl(v.pageUrl || v.url, 'mp4').replace(/\.mp4$/, '');
    try {
      await window.electronAPI.downloadDash(v.url, a.url,
        { desc: title, title, platform: 'generic', platformName: '通用' }, 'generic',
        { headers: buildHeaders(v) });
      if (typeof onNavigate === 'function') onNavigate('download', 'downloading');
    } catch (e) {
      setCatMsg({ type: 'error', text: '添加合并下载失败：' + (e.message || '') });
    }
  };

  // 整段下载 m3u8 / mpd 流
  const mergeHlsOrMpd = async (res) => {
    setCatMsg(null);
    const title = catTitle.trim() || nameFromUrl(res.pageUrl || res.url, 'mp4').replace(/\.mp4$/, '');
    try {
      if (res.type === 'm3u8') {
        await window.electronAPI.downloadM3u8(res.url, { desc: title, title, platform: 'generic', platformName: '通用' }, 'generic', { headers: buildHeaders(res) });
      } else if (res.type === 'dash') {
        await window.electronAPI.downloadMpd(res.url, { desc: title, title, platform: 'generic', platformName: '通用' }, 'generic', { headers: buildHeaders(res) });
      } else {
        return;
      }
      if (typeof onNavigate === 'function') onNavigate('download', 'downloading');
    } catch (e) {
      setCatMsg({ type: 'error', text: '添加下载失败：' + (e.message || '') });
    }
  };

  const catCopy = async (u) => {
    try {
      await window.electronAPI.copyText(u);
      setCatCopied('已复制地址');
      setTimeout(() => setCatCopied(''), 1600);
    } catch (e) { /* ignore */ }
  };

  // ===== B 站完整流解析 =====
  // 输入框是 B 站视频链接时，直接纯 HTTP 解析全部清晰度音视频流（无需等浏览器播放）
  const isBiliUrl = /bilibili\.com\/video\/BV|b23\.tv|\bBV[0-9A-Za-z]{10}\b/i.test(catUrl.trim());
  const parseBiliStreams = async () => {
    setBiliParsing(true);
    setBiliError('');
    setBiliStreams(null);
    try {
      const r = await window.electronAPI.biliPlayStreams(catUrl.trim());
      if (!r || !r.success) {
        setBiliError((r && r.error) || '解析失败');
        return;
      }
      setBiliStreams(r);
      // 默认选最高清晰度视频轨
      if (r.video && r.video.length > 0) setBiliQuality(String(r.video[0].id));
      if (!catTitle.trim()) setCatTitle(r.title || '');
    } catch (e) {
      setBiliError('解析失败：' + (e.message || ''));
    } finally {
      setBiliParsing(false);
    }
  };

  // 用解析到的流合并下载（platform 传 bilibili，自动带正确 Referer）
  const downloadBiliStream = async () => {
    if (!biliStreams) return;
    const v = biliStreams.video.find((x) => String(x.id) === String(biliQuality)) || biliStreams.video[0];
    const a = biliStreams.audio[0];
    if (!v || !a) { setBiliError('缺少视频轨或音频轨'); return; }
    setBiliError('');
    const title = catTitle.trim() || biliStreams.title || 'B站视频';
    try {
      await window.electronAPI.downloadDash(v.url, a.url,
        { desc: title, title, author: 'B站', platform: 'bilibili', platformName: '哔哩哔哩' }, 'bilibili', {});
      if (typeof onNavigate === 'function') onNavigate('download', 'downloading');
    } catch (e) {
      setBiliError('添加下载失败：' + (e.message || ''));
    }
  };

  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'video', label: '视频' },
    { key: 'image', label: '图片' },
    { key: 'audio', label: '音频' },
    { key: 'm3u8', label: 'HLS 流' },
  ];

  return (
    <div className="universal-page fade-in">
      <h1 className="page-title">通用下载器</h1>
      <p className="page-subtitle">嗅探网页里加载的视频 / 图片 / 音频资源，或按「猫抓」方案直读流地址合并下载</p>

      {/* 顶部模式切换 */}
      <div className="universal-tabs">
        <button className={`type-tab ${tab === 'sniff' ? 'type-tab-active' : ''}`} onClick={() => setTab('sniff')}>
          <Search size={15} /> 网页嗅探
        </button>
        <button className={`type-tab ${tab === 'cat' ? 'type-tab-active' : ''}`} onClick={() => setTab('cat')}>
          <Zap size={15} /> 猫抓方案（视频流+音频流合成）
        </button>
      </div>

      {/* ==================== 网页嗅探 ==================== */}
      {tab === 'sniff' && (
        <div className="card">
          <h2>🔍 网页嗅探</h2>
          <div className="download-form">
            <div className="sniff-input-row">
              <input
                type="text"
                className="form-input url-input"
                placeholder="输入要嗅探的网址，回车打开，如 https://www.bilibili.com/video/BVxxxx"
                value={sniffUrl}
                onChange={(e) => setSniffUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !sniffing && startSniff()}
              />
              {!sniffing ? (
                <button className="btn btn-primary" onClick={startSniff} disabled={!sniffUrl.trim()}>
                  <Search size={14} /> 开始嗅探
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={stopSniff}>
                  <X size={14} /> 停止嗅探
                </button>
              )}
            </div>

            <div className="tips">
              <span>💡</span>
              <span>会弹出独立浏览器窗口：在窗口里打开视频/图片页面、点击播放、滚动加载，页面上加载的媒体资源会实时显示在下方。HLS 流（m3u8）自动识别并整段合并下载。</span>
            </div>

            {sniffStatus && <div className={`sniff-status${sniffing ? ' sniff-status-live' : ''}`}>{sniffStatus}</div>}

            <div className="sniff-toolbar">
              <div className="sniff-filters">
                {FILTERS.map((f) => {
                  const count = f.key === 'all' ? resources.length : resources.filter((r) => r.type === f.key).length;
                  return (
                    <button
                      key={f.key}
                      className={`sniff-filter${filter === f.key ? ' active' : ''}`}
                      onClick={() => setFilter(f.key)}
                    >
                      {f.label} <span className="sniff-count">{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="sniff-actions">
                {copiedMsg && <span className="sniff-copied">{copiedMsg}</span>}
                <button className="btn btn-secondary btn-sm" onClick={downloadAll} disabled={filtered.length === 0} title="下载当前筛选出的所有资源">
                  <Download size={13} /> 下载全部（{filtered.length}）
                </button>
                <button className="btn btn-secondary btn-sm" onClick={clearSniff} disabled={resources.length === 0} title="清空列表">
                  <Trash2 size={13} /> 清空
                </button>
              </div>
            </div>

            {resources.length === 0 ? (
              <div className="sniff-empty">
                {sniffing ? '等待资源加载… 在嗅探窗口里打开/播放页面内容' : '尚未嗅探到资源。点击「开始嗅探」打开浏览器窗口后，页面加载的媒体资源会出现在这里。'}
              </div>
            ) : (
              <div className="sniff-list">
                {filtered.length === 0 ? (
                  <div className="sniff-empty">当前筛选下没有资源</div>
                ) : filtered.map((res, i) => (
                  <div className="sniff-item" key={res.url}>
                    {/* 图片资源显示缩略图，用户一眼认出下载哪个 */}
                    {res.type === 'image' ? (
                      <div className="sniff-thumb-wrap">
                        <img
                          className="sniff-thumb"
                          src={res.url}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                        />
                        <span className={`sniff-type sniff-type-image sniff-type-overlay`}>
                          {TYPE_ICONS.image}
                        </span>
                      </div>
                    ) : (
                      <span className={`sniff-type sniff-type-${res.type}`}>
                        {TYPE_ICONS[res.type] || <Link2 size={14} />}
                        {TYPE_LABELS[res.type] || res.type}
                      </span>
                    )}
                    <div className="sniff-mid">
                      <span className="sniff-url" title={res.url}>{res.url}</span>
                      {res.size > 0 && <span className="sniff-size">{fmtSize(res.size)}</span>}
                    </div>
                    <div className="sniff-item-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => downloadOne(res, i)} title="加入下载管理">
                        <Download size={12} /> 下载
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => copyUrl(res.url)} title="复制地址">
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== 猫抓方案 ==================== */}
      {tab === 'cat' && (
        <div className="card">
          <h2>🐱 猫抓方案 · 直接播放，截取视频流 + 音频流合成</h2>
          <p className="cat-desc">
            打开内置浏览器播放目标视频 → 自动截取页面的视频流（.m4s 视频轨）与音频流（.m4s 音频轨）→
            分别下载后用 ffmpeg 无损合并（-c copy，不重新编码）为单个 mp4。
            也支持整段截取 m3u8（HLS）播放列表和 mpd（DASH 清单）。
          </p>

          {/* 打开浏览器 */}
          <div className="sniff-input-row cat-browser-row">
            <input
              type="text"
              className="form-input url-input"
              placeholder="输入要播放的网页地址，回车打开，如 https://www.bilibili.com/video/BVxxxx"
              value={catUrl}
              onChange={(e) => setCatUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !catBrowserOn && openCatBrowser()}
            />
            {isBiliUrl && (
              <button className="btn btn-primary" onClick={parseBiliStreams} disabled={biliParsing}>
                <Zap size={14} /> {biliParsing ? '解析中…' : '解析 B 站完整流'}
              </button>
            )}
            {!catBrowserOn ? (
              <button className="btn btn-secondary" onClick={openCatBrowser} disabled={!catUrl.trim()}>
                <Zap size={14} /> 打开浏览器并截取
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={closeCatBrowser}>
                <X size={14} /> 关闭浏览器
              </button>
            )}
          </div>
          {catStatus && <div className={`sniff-status${catBrowserOn ? ' sniff-status-live' : ''}`}>{catStatus}</div>}

          {/* B 站完整流面板：纯 HTTP 解析，不依赖播放器 */}
          {isBiliUrl && (
            <div className="cat-bili-panel">
              <div className="cat-bili-head">
                <span className="cat-bili-title">🎯 B 站完整流解析</span>
                <span className="cat-bili-hint">
                  {biliStreams ? (
                    biliStreams.needLogin
                      ? '未登录 B 站，仅 480P 及以下；在「登录平台账号」登录后可解析 1080P+'
                      : '已获取全部清晰度，选择后一键合并下载'
                  ) : '点击右侧「解析 B 站完整流」，直接拿到全部清晰度音视频流'}
                </span>
              </div>
              {biliError && <div className="alert alert-danger" style={{ marginTop: 8 }}>❌ {biliError}</div>}
              {biliStreams && biliStreams.success !== false && (
                <div className="cat-bili-body">
                  <div className="cat-bili-meta">
                    <span className="cat-bili-title-text">{biliStreams.title}</span>
                    <span className="cat-bili-dur">时长 {Math.floor(biliStreams.duration / 60)}:{String(biliStreams.duration % 60).padStart(2, '0')}</span>
                  </div>
                  <div className="cat-bili-row">
                    <label className="cat-title-field">
                      <span>清晰度</span>
                      <select className="form-input" value={biliQuality} onChange={(e) => setBiliQuality(e.target.value)}>
                        {biliStreams.video.map((v) => (
                          <option key={v.id} value={v.id}>{v.label} ({v.codecs})</option>
                        ))}
                      </select>
                    </label>
                    <label className="cat-title-field">
                      <span>音频轨</span>
                      <select className="form-input" value={biliStreams.audio[0] ? String(biliStreams.audio[0].id) : ''}>
                        {biliStreams.audio.map((a) => (
                          <option key={a.id} value={a.id}>{a.label}</option>
                        ))}
                      </select>
                    </label>
                    <button className="btn btn-primary" onClick={downloadBiliStream}>
                      <Zap size={14} /> 合并下载为 mp4
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 当前配对：自动识别视频轨 + 音频轨 */}
          <div className="cat-pair">
            <div className="cat-pair-head">
              <span className="cat-pair-title">🎯 当前截取的音视频流</span>
              <span className="cat-pair-hint">自动配对最近一组视频轨/音频轨，可点击下方流条目手动重配</span>
            </div>
            <div className="cat-pair-row">
              <div className="cat-pair-box cat-pair-video">
                <span className="cat-pair-role">视频轨</span>
                {autoVideo ? (
                  <span className="cat-pair-url" title={autoVideo.url}>{autoVideo.url}</span>
                ) : (
                  <span className="cat-pair-empty">未截取到视频流（在浏览器里播放视频）</span>
                )}
              </div>
              <div className="cat-pair-merge">
                <Zap size={15} />
              </div>
              <div className="cat-pair-box cat-pair-audio">
                <span className="cat-pair-role">音频轨</span>
                {autoAudio ? (
                  <span className="cat-pair-url" title={autoAudio.url}>{autoAudio.url}</span>
                ) : (
                  <span className="cat-pair-empty">未截取到音频流</span>
                )}
              </div>
            </div>

            <div className="cat-pair-actions">
              <label className="cat-title-field">
                <span>保存文件名</span>
                <input
                  type="text"
                  className="form-input"
                  placeholder="留空则按页面自动取名"
                  value={catTitle}
                  onChange={(e) => setCatTitle(e.target.value)}
                />
              </label>
              <button
                className="btn btn-primary"
                onClick={mergeDashPair}
                disabled={!autoVideo || !autoAudio}
                title="分别下载视频流/音频流后用 ffmpeg 合并为 mp4"
              >
                <Zap size={14} /> 合并下载为 mp4
              </button>
            </div>

            {catBrowserOn && autoVideo && !autoAudio && (
              <div className="cat-pair-tip">
                ⚠️ 只截取到视频轨，未截取到音频轨。部分站点（如 B 站）的音频轨需要播放器真正播放后才加载：
                请在浏览器窗口里点一下视频画面播放、或拖动播放进度条，音频流会自动出现在下方列表，然后点「设为音频轨」。
              </div>
            )}
            {!catBrowserOn && !autoVideo && (
              <div className="cat-pair-tip">
                💡 点击「打开浏览器并截取」，在浏览器窗口里播放目标视频，即可自动截取视频轨 + 音频轨。
              </div>
            )}
          </div>

          {catMsg && (
            <div className={`alert alert-${catMsg.type === 'error' ? 'danger' : 'info'}`}>
              {catMsg.type === 'error' ? '❌ ' : 'ℹ️ '}{catMsg.text}
            </div>
          )}

          {/* 截取到的流列表 */}
          <div className="cat-streams-head">
            <span>📡 截取到的流</span>
            {catCopied && <span className="sniff-copied">{catCopied}</span>}
          </div>
          {catStreams.length === 0 ? (
            <div className="sniff-empty">
              {catBrowserOn
                ? '正在等待流数据… 在浏览器窗口里点击播放视频（最好全屏/倍速播放以便截取完整流）'
                : '尚未截取到流。点击「打开浏览器并截取」，在浏览器窗口播放视频即可自动捕获音视频流'}
            </div>
          ) : (
            <div className="sniff-list">
              {catStreams.map((res, i) => {
                const isVideoChosen = chosenVideo === res;
                const isAudioChosen = chosenAudio === res;
                return (
                  <div className="sniff-item" key={res.url + i}>
                    <span className={`sniff-type sniff-type-${res.type}`}>
                      {TYPE_ICONS[res.type] || <Link2 size={14} />}
                      {TYPE_LABELS[res.type] || res.type}
                    </span>
                    <span className="sniff-url" title={res.url}>{res.url}</span>
                    {res.size > 0 && <span className="sniff-size">{fmtSize(res.size)}</span>}
                    <div className="sniff-item-actions">
                      {res.type === 'video_dash' && (
                        <button className={`btn btn-sm ${isVideoChosen ? 'btn-primary' : 'btn-secondary'}`} onClick={() => chooseAs(res, 'video')} title="设为合并用的视频轨">
                          {isVideoChosen ? '✓ 视频轨' : '设为视频轨'}
                        </button>
                      )}
                      {res.type === 'audio_dash' && (
                        <button className={`btn btn-sm ${isAudioChosen ? 'btn-primary' : 'btn-secondary'}`} onClick={() => chooseAs(res, 'audio')} title="设为合并用的音频轨">
                          {isAudioChosen ? '✓ 音频轨' : '设为音频轨'}
                        </button>
                      )}
                      {(res.type === 'm3u8' || res.type === 'dash') && (
                        <button className="btn btn-primary btn-sm" onClick={() => mergeHlsOrMpd(res)} title="整段下载并合并为 mp4">
                          <Download size={12} /> 整段合并下载
                        </button>
                      )}
                      <button className="btn btn-secondary btn-sm" onClick={() => catCopy(res.url)} title="复制地址">
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="cat-note">下载进度在「下载管理」中查看；合并失败时会保留分离的分片供手动处理。</p>
        </div>
      )}
    </div>
  );
}

export default UniversalDownload;
