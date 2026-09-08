import React, { useState } from 'react';
import './MySelfDownload.css';
// 复用账号管理的弹窗/作品列表样式
import './AccountManager.css';
import { ModalErrorBoundary } from './AccountManager';
import { isImageWork, buildImageWorkItems, pickQualityUrl } from '../utils/douyinWork';
import { AlertCircle, Film, X, Copy } from './icons';

function formatNumber(num) {
  if (typeof num !== 'number') return '0';
  if (num >= 100000000) return (num / 100000000).toFixed(2) + '亿';
  if (num >= 10000) return (num / 10000).toFixed(2) + '万';
  return String(num);
}

// 我的账号（下载专区）：当前登录抖音账号的自我数据下载（纯逆向）。
// 与运营专区的「我的账号」（绑定账号/播放量/增速/爆款分析）完全独立。
const SELF_TABS = [
  { id: 'post', label: '我的发布' },
  { id: 'recommend', label: '推荐' },
  { id: 'like', label: '喜欢' },
  { id: 'favorite', label: '收藏' },
  { id: 'history', label: '观看历史' },
  { id: 'watch_later', label: '稍后再看' },
];

function MySelfDownload() {
  const [selfTab, setSelfTab] = useState('post'); // 当前选中的 tab
  const [selfMaxPages, setSelfMaxPages] = useState(10); // 页数限制（与主页下载一致）
  const [selfLoading, setSelfLoading] = useState(false); // 获取中
  const [selfStage, setSelfStage] = useState('fetch'); // 阶段：scroll(滚动捕获) | fetch(重放取数)
  const [selfProgress, setSelfProgress] = useState({ current: 0, total: 0, fetched: 0 });
  const [selfVideos, setSelfVideos] = useState([]); // 当前 tab 的作品列表
  const [selfSelected, setSelfSelected] = useState(new Set());
  const [selfModalOpen, setSelfModalOpen] = useState(false); // 结果弹窗
  const [selfDownloading, setSelfDownloading] = useState(false); // 批量下载中
  const [selfCopyFeedback, setSelfCopyFeedback] = useState(null); // 复制链接提示
  const [error, setError] = useState(null);

  const selfTabLabel = () => (SELF_TABS.find((t) => t.id === selfTab) || {}).label || '我的账号';

  // 获取当前 tab 数据（主进程隐藏窗口滚动捕获签名 + net.fetch 重放，订阅逐页进度）
  const handleFetchSelf = async (tab) => {
    const cfg = SELF_TABS.find((t) => t.id === tab) || SELF_TABS[0];
    setSelfLoading(true);
    setError(null);
    setSelfProgress({ current: 0, total: 0, fetched: 0 });
    const unsubscribe = window.electronAPI.onSelfProgress((p) => {
      setSelfStage(p.stage || 'fetch');
      setSelfProgress({ current: p.page || 0, total: p.total || 0, fetched: p.fetched || 0 });
    });
    try {
      const res = await window.electronAPI.douyinSelfFetch(cfg.id, selfMaxPages);
      const videos = (res && res.success) ? (res.videos || []) : [];
      if (!videos || videos.length === 0) {
        throw new Error((res && res.error) || `未获取到「${cfg.label}」数据，请确认已通过「登录平台账号」登录`);
      }
      setSelfVideos(videos);
      setSelfSelected(new Set(videos.map((_, idx) => idx)));
      setSelfModalOpen(true);
    } catch (err) {
      console.error(`获取「${cfg.label}」失败:`, err);
      setError(err.message || '获取失败');
    } finally {
      unsubscribe();
      setSelfLoading(false);
      setSelfStage('fetch');
    }
  };

  // 切换列表选择
  const toggleSelfSelection = (index) => {
    const newSelected = new Set(selfSelected);
    if (newSelected.has(index)) newSelected.delete(index);
    else newSelected.add(index);
    setSelfSelected(newSelected);
  };

  // 全选/取消全选
  const toggleSelfSelectAll = () => {
    if (selfSelected.size === selfVideos.length) setSelfSelected(new Set());
    else setSelfSelected(new Set(selfVideos.map((_, idx) => idx)));
  };

  // 批量复制列表链接（每行一条）
  const copySelfAllLinks = async () => {
    if (!selfVideos.length) return;
    try {
      await window.electronAPI.copyText(selfVideos.map((aw) => `https://www.douyin.com/video/${aw.aweme_id}`).join('\n'));
      setSelfCopyFeedback(`已复制 ${selfVideos.length} 条链接`);
    } catch (err) {
      setSelfCopyFeedback('复制失败');
    }
    setTimeout(() => setSelfCopyFeedback(null), 1600);
  };

  // 批量下载（与主页下载一致：图文走图集，视频走最高画质直链，命名格式同样生效）
  const handleSelfBatchDownload = async () => {
    if (selfSelected.size === 0) return;
    setSelfDownloading(true);
    try {
      const batchId = `myself_${selfTab}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const folderName = `${selfTabLabel()}--${selfTabLabel()}`;
      const batchInfo = { nickname: folderName, authorName: selfTabLabel(), profileUrl: '', avatar: '', platform: 'douyin', folderName };
      const options = { customDir: folderName, batchId, batchInfo };
      for (const index of selfSelected) {
        const video = selfVideos[index];
        if (!video) continue;
        const videoInfo = {
          desc: video.desc,
          title: video.desc,
          author: video.author?.nickname || '',
          uid: video.author?.uid,
          create_time: video.create_time,
          awemeId: video.aweme_id,
          platform: 'douyin',
          sourceUrl: video.share_url || '',
        };
        // 图文作品（图集+背景音乐）
        if (isImageWork(video)) {
          const items = buildImageWorkItems(video);
          if (items.length === 0) continue;
          await window.electronAPI.downloadAlbum(items, videoInfo, 'douyin', options);
          continue;
        }
        // 普通视频：最高画质直链
        const videoUrl = pickQualityUrl(video, 'auto');
        if (!videoUrl) continue;
        const filename = `${(video.desc || 'douyin_video').substring(0, 50)}_${video.aweme_id || Date.now()}.mp4`;
        const sanitized = filename.replace(/[<>:"/\\|?*\n\r]/g, '_');
        await window.electronAPI.downloadFile(videoUrl, sanitized, videoInfo, 'douyin', options);
      }
      setSelfModalOpen(false);
      setSelfVideos([]);
      setSelfSelected(new Set());
    } catch (err) {
      console.error('我的账号批量下载失败:', err);
      setError(err.message || '批量下载失败');
    } finally {
      setSelfDownloading(false);
    }
  };

  return (
    <div className="my-self-download fade-in">
      <h1 className="my-self-title">📥 我的账号</h1>
      <p className="my-self-subtitle">
        当前登录账号（「登录平台账号」的 Cookie）的 发布/推荐/喜欢/收藏/观看历史/稍后再看 数据下载：
        无需输入链接，选好类别设好页数，点「开始获取」即可，结果可勾选后批量下载
      </p>

      <div className="card my-likes-card">
        <div className="my-likes-header">
          <div className="my-likes-info">
            <h2 className="my-likes-title">我的账号数据</h2>
            <p className="my-likes-desc">
              与主页下载功能一致：分页抓取、显示进度、批量下载
            </p>
          </div>
          <div className="my-likes-controls">
            <label className="my-likes-label">
              获取页数限制:
              <select
                className="settings-select"
                value={selfMaxPages}
                onChange={(e) => setSelfMaxPages(parseInt(e.target.value))}
              >
                <option value={5}>5页 (约100个作品)</option>
                <option value={10}>10页 (约200个作品)</option>
                <option value={20}>20页 (约400个作品)</option>
                <option value={50}>50页 (约1000个作品)</option>
                <option value={100}>100页 (约2000个作品)</option>
                <option value={999}>全部获取</option>
              </select>
            </label>
            <button
              className="btn btn-primary"
              onClick={() => handleFetchSelf(selfTab)}
              disabled={selfLoading}
              title={`纯逆向抓取当前登录账号的「${selfTabLabel()}」`}
            >
              {selfLoading ? <span className="loading-spinner"></span> : <Film size={15} />}
              {selfLoading ? '获取中...' : '开始获取'}
            </button>
          </div>
        </div>

        {/* 6 个数据类别 tab（与主页下载的 tab 样式一致） */}
        <div className="download-type-tabs my-self-tabs">
          {SELF_TABS.map((t) => (
            <button
              key={t.id}
              className={`type-tab${selfTab === t.id ? ' type-tab-active' : ''}`}
              onClick={() => setSelfTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="my-accounts-error">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {selfLoading && selfProgress.total > 0 && (
          <div className="my-likes-progress">
            <div className="my-likes-progress-header">
              <span className="my-likes-progress-label">获取进度</span>
              <span className="my-likes-progress-count">
                {selfStage === 'scroll'
                  ? `滚动捕获 ${selfProgress.current}/${selfProgress.total} 次 · 已捕获 ${selfProgress.fetched || 0} 个分页`
                  : `获取作品 ${selfProgress.current}/${selfProgress.total} 页 · 已获取 ${selfProgress.fetched || 0} 条`}
              </span>
            </div>
            <div className="my-likes-progress-bar-wrap">
              <div
                className="my-likes-progress-bar"
                style={{ width: `${Math.min(100, Math.round((selfProgress.current / selfProgress.total) * 100))}%` }}
              ></div>
            </div>
            <div className="my-likes-progress-text">
              {selfStage === 'scroll'
                ? `正在滚动「${selfTabLabel()}」页捕获分页签名（数据到底会自动停止）...`
                : '正在逐页重放取数（每页用页面生成的签名，纯 HTTP 获取）...'}
            </div>
          </div>
        )}
      </div>

      {/* 结果弹窗（与主页下载一致：全选/复制链接/批量下载） */}
      {selfModalOpen && (
        <ModalErrorBoundary onClose={() => setSelfModalOpen(false)}>
          <div className="account-modal-overlay" onClick={() => setSelfModalOpen(false)}>
            <div className="account-modal account-modal-lg" onClick={(e) => e.stopPropagation()}>
              <div className="account-modal-head">
                <div className="account-modal-title">
                  <div className="account-modal-avatar">
                    <div className="avatar-placeholder"><Film size={22} /></div>
                  </div>
                  <div>
                    <h3>{selfTabLabel()}</h3>
                    <p>当前登录账号 · 共 {selfVideos.length} 条</p>
                  </div>
                </div>
                <button className="account-modal-close" onClick={() => setSelfModalOpen(false)} title="关闭">
                  <X size={18} />
                </button>
              </div>

              <div className="account-modal-body">
                <div className="my-likes-toolbar">
                  <label className="my-likes-checkbox">
                    <input
                      type="checkbox"
                      checked={selfSelected.size === selfVideos.length && selfSelected.size > 0}
                      onChange={toggleSelfSelectAll}
                    />
                    <span>全选 ({selfSelected.size}/{selfVideos.length})</span>
                  </label>
                  <button
                    className={`btn btn-sm btn-secondary works-copy-btn${selfCopyFeedback ? ' has-feedback' : ''}`}
                    onClick={copySelfAllLinks}
                    disabled={selfVideos.length === 0}
                    title="复制当前列表的全部链接，每行一条"
                  >
                    <Copy size={13} />
                    {selfCopyFeedback || '复制全部链接'}
                  </button>
                </div>

                <div className="works-list my-likes-list">
                  {selfVideos.map((aw, idx) => {
                    const st = aw.statistics || {};
                    return (
                      <label key={aw.aweme_id || idx} className="my-likes-item" title={aw.desc || '无标题'}>
                        <input
                          type="checkbox"
                          className="my-likes-item-check"
                          checked={selfSelected.has(idx)}
                          onChange={() => toggleSelfSelection(idx)}
                        />
                        <div className="work-cover">
                          {aw.video?.cover?.url_list?.[0] ? (
                            <img src={aw.video.cover.url_list[0]} alt="" />
                          ) : (
                            <div className="work-cover-ph"><Film size={18} /></div>
                          )}
                        </div>
                        <div className="work-main">
                          <div className="work-title">{(aw.desc || '无标题').slice(0, 40)}</div>
                          <div className="work-stats" style={{ width: '100%' }}>
                            <span>👤 {aw.author?.nickname || '未知作者'}</span>
                            <span title={`播放量: ${(st.play_count || 0).toLocaleString()}`}>👁 {formatNumber(st.play_count)}</span>
                            <span title={`点赞量: ${(st.digg_count || 0).toLocaleString()}`}>❤ {formatNumber(st.digg_count)}</span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="my-likes-foot">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setSelfModalOpen(false); setSelfVideos([]); setSelfSelected(new Set()); }}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSelfBatchDownload}
                  disabled={selfSelected.size === 0 || selfDownloading}
                >
                  {selfDownloading ? '下载中...' : `确认下载 (${selfSelected.size})`}
                </button>
              </div>
            </div>
          </div>
        </ModalErrorBoundary>
      )}
    </div>
  );
}

export default MySelfDownload;
