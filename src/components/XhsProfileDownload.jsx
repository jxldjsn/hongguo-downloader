import React, { useState, useEffect } from 'react';
// 复用主页下载的弹窗/列表/按钮布局样式，再叠加小红书专属样式
import './ProfileDownload.css';
import './XhsProfileDownload.css';

/**
 * 小红书主页批量下载
 *
 * 流程：粘贴主页 URL -> 隐藏窗口抓取全部作品（视频+笔记图文）-> 弹窗勾选 -> 批量下载
 *
 * 后端用隐藏 BrowserWindow 加载主页 + 拦截 user_posted 响应（绕过 x-s 签名），
 * 需登录态：未登录时在本页面直接打开小红书登录窗口，无需跳转。
 */
function XhsProfileDownload({ pythonRunning = false, onNavigate }) {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(999); // 获取页数限制（默认全部获取，999=翻到没有更多为止）
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [userInfo, setUserInfo] = useState(null);
  const [notes, setNotes] = useState([]);          // 作品列表（展示用，normalizeNote 结构）
  const [showModal, setShowModal] = useState(false);
  const [selectedNotes, setSelectedNotes] = useState(new Set()); // 勾选的下标
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, status: '' });
  const [fetchNotice, setFetchNotice] = useState(null);
  // 抓取进度：{ stage, current, message } | null
  const [fetchProgress, setFetchProgress] = useState(null);
  // 小红书登录态
  const [cookieStatus, setCookieStatus] = useState(null); // null=检查中, {isLoggedIn, message}
  const [loginLoading, setLoginLoading] = useState(false);

  // 挂载时检查小红书登录态
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await window.electronAPI.checkCookieStatus('xiaohongshu');
        if (!cancelled) setCookieStatus(res || { isLoggedIn: false, message: '未检测到登录态' });
      } catch (e) {
        if (!cancelled) setCookieStatus({ isLoggedIn: false, message: '检查失败' });
      }
    };
    check();
    return () => { cancelled = true; };
  }, []);

  // 监听后端推送的小红书主页抓取进度（阶段 + 已累计条数）
  useEffect(() => {
    const unsubscribeProgress = window.electronAPI.onXhsProfileProgress((p) => {
      if (p) setFetchProgress(p);
    });
    return () => {
      unsubscribeProgress();
    };
  }, []);

  // 在本页面直接打开小红书登录窗口
  const handleLogin = async () => {
    setLoginLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.openLoginWindow('xiaohongshu');
      if (result.success) {
        setCookieStatus({ isLoggedIn: true, message: '已登录' });
      } else {
        setError('登录失败：' + (result.error || '未知错误'));
      }
    } catch (err) {
      setError('登录出错：' + (err.message || '未知错误'));
    } finally {
      setLoginLoading(false);
    }
  };

  // 解析主页
  const handleFetchProfile = async () => {
    if (!url.trim()) {
      setError('请输入小红书主页链接，例如 https://www.xiaohongshu.com/user/profile/64283ee1...');
      return;
    }

    setLoading(true);
    setError(null);
    setUserInfo(null);
    setNotes([]);
    setFetchNotice(null);
    setSelectedNotes(new Set());
    setFetchProgress({ stage: 'loading', current: 0, message: '正在加载小红书主页...', percent: 5 });

    try {
      const res = await window.electronAPI.xhsProfileList(url.trim(), maxPages);
      if (res && res.success && res.data) {
        setUserInfo(res.data.user || {});
        const list = res.data.notes || [];
        setNotes(list);
        if (list.length === 0) {
          setFetchNotice({ type: 'empty', message: '未抓取到任何作品。可能是未登录、主页无公开作品，或触发了风控。请先登录小红书后重试。' });
        } else if (res.data.truncated) {
          // 因页数限制或网络中断提前停止：数量可能不全，明确提醒用户
          const reason = res.data.stopReason ? `（${res.data.stopReason}）` : '';
          setFetchNotice({
            type: 'partial',
            message: `⚠️ 本次仅获取前 ${res.data.fetchedPages || ''} 页（共 ${list.length} 条），可能未抓完${reason}。建议稍等几分钟后重新获取，或将「获取页数限制」调为「全部获取」重试。`,
          });
        }
        setShowModal(true);
      } else {
        // 未登录特殊引导：本页面直接登录
        if (res && res.needLogin) {
          setError('未检测到小红书登录态，请先点击下方「登录小红书」按钮完成登录，再抓取。');
        } else {
          setError(res?.error || '抓取失败，请检查链接是否正确');
        }
      }
    } catch (err) {
      console.error('小红书主页抓取失败:', err);
      setError(err.message || '抓取失败');
    } finally {
      setLoading(false);
      setFetchProgress(null);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text);
        setError(null);
      }
    } catch (err) {
      setError('无法读取剪贴板，请手动粘贴');
    }
  };

  const handleClear = () => {
    setUrl('');
    setError(null);
    setUserInfo(null);
    setNotes([]);
    setFetchNotice(null);
  };

  const closeModal = () => {
    if (batchDownloading) return; // 下载中不允许关闭
    setShowModal(false);
    setFetchNotice(null);
  };

  const toggleNoteSelection = (index) => {
    setSelectedNotes(prev => {
      const s = new Set(prev);
      if (s.has(index)) s.delete(index); else s.add(index);
      return s;
    });
  };

  const toggleSelectAll = () => {
    if (selectedNotes.size === notes.length) {
      setSelectedNotes(new Set());
    } else {
      setSelectedNotes(new Set(notes.map((_, i) => i)));
    }
  };

  // 格式化数字（万）
  const formatNumber = (n) => {
    if (!n) return '0';
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  };

  // 格式化时间戳
  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // 批量下载：一次性把选中笔记提交给主进程，主进程入队为 parsing 任务 + 后台并发解析转下载。
  // 前端不等解析，立即跳转到下载管理页看进度（解析中→等待中→下载中→已完成）。
  const handleBatchDownload = async () => {
    const picked = Array.from(selectedNotes).sort((a, b) => a - b).map(i => notes[i]).filter(Boolean);
    if (picked.length === 0) return;

    setBatchDownloading(true);
    setError(null);
    setBatchProgress({ current: 0, total: picked.length, status: '正在提交到下载管理...' });

    try {
      // 传笔记列表 + 主页链接 + 用户信息，主进程用于给同批任务打 batchId 分组
      const r = await window.electronAPI.xhsProfileDownloadBatch({
        notes: picked,
        profileUrl: url.trim(),
        userInfo: userInfo || {},
      });
      if (r && r.success) {
        // 提交成功：清空本页选中状态，跳转到下载管理页（"下载中"标签）
        setShowModal(false);
        setNotes([]);
        setSelectedNotes(new Set());
        setFetchNotice(null);
        if (typeof onNavigate === 'function') {
          onNavigate('download', 'downloading');
        } else {
          setBatchProgress({ current: picked.length, total: picked.length, status: `已提交 ${r.count || picked.length} 个任务到下载管理，请前往「下载管理」查看` });
        }
      } else {
        setError(r?.error || '提交失败');
        setBatchDownloading(false);
      }
    } catch (err) {
      console.error('小红书批量下载提交失败:', err);
      setError(err.message || '提交失败');
      setBatchDownloading(false);
    }
  };

  return (
    <div className="xhs-profile-page fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon">📕</span>
          小红书主页下载
        </h1>
        <p className="hero-subtitle">
          批量获取主页全部视频与笔记图文，勾选后一键下载
        </p>
      </div>

      {/* 登录状态栏 */}
      <div className="xhs-login-bar">
        <div className="xhs-login-info">
          <span className={`xhs-login-dot ${cookieStatus?.isLoggedIn ? 'is-ok' : 'is-off'}`}></span>
          <span className="xhs-login-text">
            {cookieStatus === null
              ? '正在检查登录状态...'
              : (cookieStatus.isLoggedIn
                  ? <>✓ 小红书已登录<span className="xhs-login-sub">· 抓取需登录态，未登录会失败</span></>
                  : '✗ 小红书未登录')}
          </span>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleLogin}
          disabled={loginLoading}
          type="button"
        >
          {loginLoading
            ? <><span className="mp-spinner"></span> 登录中...</>
            : (cookieStatus?.isLoggedIn ? '🔄 重新登录' : '🔑 登录小红书')}
        </button>
      </div>

      <div className="card">
        <div className="download-form">
          <div className="settings-row">
            <label className="settings-label">
              获取页数限制:
              <select
                className="settings-select"
                value={maxPages}
                onChange={(e) => setMaxPages(parseInt(e.target.value))}
              >
                <option value={5}>5页 (约150个作品)</option>
                <option value={10}>10页 (约300个作品)</option>
                <option value={20}>20页 (约600个作品)</option>
                <option value={50}>50页 (约1500个作品)</option>
                <option value={100}>100页 (约3000个作品)</option>
                <option value={999}>全部获取</option>
              </select>
            </label>
          </div>
          <div className="input-group">
            <input
              type="text"
              className="form-input url-input"
              placeholder="粘贴小红书主页链接，如 https://www.xiaohongshu.com/user/profile/64283ee1..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleFetchProfile()}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={handlePaste}
              type="button"
            >
              📋 粘贴
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleClear}
              type="button"
            >
              清空
            </button>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleFetchProfile}
            disabled={loading || !url.trim()}
          >
            {loading ? (
              <><span className="mp-spinner"></span> 抓取中...</>
            ) : '🔍 获取作品列表'}
          </button>
        </div>

        <div className="tips">
          <span>💡</span>
          <span>需先登录小红书。抓取需滚动加载，可能耗时数秒到数十秒；建议一次不要抓取过多以防风控。</span>
        </div>

        {/* 抓取进度（阶段文字 + 已累计条数 + 进度条） */}
        {loading && fetchProgress && (
          <div className="xhs-fetch-progress">
            <div className="xhs-fetch-progress-text">
              <span className="xhs-fetch-spinner"></span>
              <span className="xhs-fetch-stage">{fetchProgress.message}</span>
              {fetchProgress.current > 0 && (
                <span className="xhs-fetch-count">{fetchProgress.current} 条</span>
              )}
              {fetchProgress.percent != null && (
                <span className="xhs-fetch-percent">{fetchProgress.percent}%</span>
              )}
            </div>
            <div className="xhs-fetch-bar">
              <div
                className={`xhs-fetch-bar-fill is-stage-${fetchProgress.stage}`}
                style={{ width: (fetchProgress.percent != null ? fetchProgress.percent : (fetchProgress.stage === 'done' ? 100 : 40)) + '%' }}
              ></div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-danger">
          ❌ {error}
        </div>
      )}

      {/* 批量下载弹窗 */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {userInfo?.nickname ? `${userInfo.nickname} 的作品` : '作品列表'}
                <span className="xhs-count">（{notes.length}）</span>
              </h3>
              <button type="button" className="modal-close" onClick={closeModal} disabled={batchDownloading}>×</button>
            </div>

            {fetchNotice && (
              <div className="profile-fetch-notice is-partial">
                <span className="profile-fetch-notice-icon">⚠️</span>
                <span className="profile-fetch-notice-text">{fetchNotice.message}</span>
              </div>
            )}

            <div className="modal-body">
              <div className="select-all-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedNotes.size === notes.length && selectedNotes.size > 0}
                    onChange={toggleSelectAll}
                    disabled={notes.length === 0 || batchDownloading}
                  />
                  <span>全选（{selectedNotes.size}/{notes.length}）</span>
                </label>
                {batchDownloading && (
                  <span className="batch-progress-text">
                    {batchProgress.current}/{batchProgress.total} · {batchProgress.status}
                  </span>
                )}
              </div>

              <div className="xhs-note-grid">
                {notes.map((note, index) => {
                  const selected = selectedNotes.has(index);
                  return (
                    <div
                      key={index}
                      className={`xhs-note-card ${selected ? 'is-selected' : ''}`}
                      onClick={() => !batchDownloading && toggleNoteSelection(index)}
                    >
                      <div className="xhs-note-cover">
                        {note.cover
                          ? <img src={note.cover} alt="" loading="lazy" onError={(e) => { e.target.style.display = 'none'; }} />
                          : <span className="xhs-cover-fallback">{note.type === 'video' ? '🎬' : '🖼️'}</span>}
                        <span className={`xhs-type-badge xhs-type-badge-${note.type}`}>
                          {note.type === 'video' ? '🎬 视频' : '🖼️ 图文'}
                        </span>
                        <label
                          className="xhs-note-check"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => !batchDownloading && toggleNoteSelection(index)}
                            disabled={batchDownloading}
                          />
                          <span className="xhs-check-dot"></span>
                        </label>
                        {note.type === 'video' && (
                          <span className="xhs-play-mark">▶</span>
                        )}
                      </div>
                      <div className="xhs-note-body">
                        <div className="xhs-note-title">{note.title || '无标题'}</div>
                        <div className="xhs-note-stats">
                          <span className="xhs-stat">👍 {formatNumber(note.statistics?.liked)}</span>
                          <span className="xhs-stat">💬 {formatNumber(note.statistics?.comment)}</span>
                          <span className="xhs-stat">⭐ {formatNumber(note.statistics?.collected)}</span>
                          {note.createTime && <span className="xhs-time">{formatTime(note.createTime)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal} disabled={batchDownloading}>
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleBatchDownload}
                disabled={selectedNotes.size === 0 || batchDownloading}
              >
                {batchDownloading
                  ? `提交中 ${batchProgress.current}/${batchProgress.total}`
                  : `⬇️ 下载选中（${selectedNotes.size}）`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default XhsProfileDownload;
