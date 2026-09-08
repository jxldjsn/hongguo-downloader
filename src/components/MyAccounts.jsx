import React, { useState, useEffect } from 'react';
import './MyAccounts.css';
// 复用账号管理的卡片/增速弹窗样式
import './AccountManager.css';
import HotVideoAnalysisModal from './HotVideoAnalysisModal';
import { AccountGrowthModal, ModalErrorBoundary } from './AccountManager';
import { exportVideosToXlsx } from '../utils/xlsxExport';
import {
  User, Plus, Trash2, RefreshCw, Eye, Flame, AlertCircle, TrendingUp, Film,
  Clock, X, Copy, ExternalLink,
} from './icons';

function formatNumber(num) {
  if (typeof num !== 'number') return '0';
  if (num >= 100000000) return (num / 100000000).toFixed(2) + '亿';
  if (num >= 10000) return (num / 10000).toFixed(2) + '万';
  return String(num);
}

// 我的账号：绑定自己的抖音账号（每个账号存独立 cookie），
// 用各自 cookie 抓作品才能看到播放量(play_count)。
// UI 与「账号管理」保持一致（除分组外），复用增速弹窗/爆款分析/作品展开/导出 Excel。
function MyAccounts() {
  const [myAccounts, setMyAccounts] = useState([]);
  const [loading, setLoading] = useState(false);       // 绑定/刷新中
  const [error, setError] = useState(null);
  const [worksByUid, setWorksByUid] = useState({});     // uid -> { list, loading, error, hasMore, cursor }
  const [worksModalAccount, setWorksModalAccount] = useState(null); // 当前打开作品弹窗的账号
  const [modalAccount, setModalAccount] = useState(null); // 增速弹窗账号
  const [analysisGroup, setAnalysisGroup] = useState(null); // 爆款分析弹窗 { name, accounts }
  const [worksSort, setWorksSort] = useState('newest'); // 作品排序：newest | digg | comment
  const [copyFeedback, setCopyFeedback] = useState(null); // 批量复制链接后的提示文案

  const loadAccounts = async () => {
    try {
      const res = await window.electronAPI.myAccountList();
      if (res && res.success) setMyAccounts(res.myAccounts || []);
    } catch (e) {
      console.error('加载我的账号失败:', e);
    }
  };

  useEffect(() => { loadAccounts(); }, []);

  // 绑定新账号（弹抖音登录窗口）
  const handleBindLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.myAccountBindLogin();
      if (res && res.success) {
        setMyAccounts(res.myAccounts || []);
      } else if (res && res.error && !/关闭了登录窗口/.test(res.error || '')) {
        setError(res.error);
      }
    } catch (e) {
      setError(e.message || '绑定失败');
    } finally {
      setLoading(false);
    }
  };

  // 绑定当前全局登录账号
  const handleBindCurrent = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.myAccountBindCurrent();
      if (res && res.success) {
        setMyAccounts(res.myAccounts || []);
      } else {
        setError(res.error || '绑定失败');
      }
    } catch (e) {
      setError(e.message || '绑定失败');
    } finally {
      setLoading(false);
    }
  };

  // 打开作品弹窗（每次打开都重新拉取，保证数据新鲜；用该账号自己的 cookie 抓取 → 播放量有值）
  const openWorks = async (acc) => {
    setCopyFeedback(null);
    setWorksModalAccount(acc);
    await fetchWorks(acc, 0);
  };

  // 拉取该账号作品（分页合并，cursor 翻页）
  const fetchWorks = async (acc, cursor = 0) => {
    const uid = acc.uid;
    setWorksByUid(prev => ({
      ...prev,
      [uid]: { ...(prev[uid] || { list: [] }), loading: true, error: null },
    }));
    try {
      const res = await window.electronAPI.myAccountWorks(uid, cursor, 30);
      if (res && res.success) {
        const list = res.works || [];
        const prev = worksByUid[uid];
        const merged = cursor === 0 ? list : [...(prev?.list || []), ...list];
        const seen = new Set();
        const dedup = merged.filter(v => { const id = v && (v.aweme_id || v.id); if (!id || seen.has(String(id))) return false; seen.add(String(id)); return true; });
        setWorksByUid(prev2 => ({
          ...prev2,
          [uid]: { list: dedup, loading: false, error: null, hasMore: !!res.hasMore, cursor: res.cursor || 0 },
        }));
      } else {
        setWorksByUid(prev2 => ({ ...prev2, [uid]: { list: prev2[uid]?.list || [], loading: false, error: res?.error || '抓取失败' } }));
      }
    } catch (e) {
      setWorksByUid(prev2 => ({ ...prev2, [uid]: { list: prev2[uid]?.list || [], loading: false, error: e.message } }));
    }
  };

  // 刷新单个账号（抓资料+作品写快照，供增速弹窗/爆款分析用）
  const handleRefresh = async (acc) => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.myAccountRefresh(acc.uid);
      if (res && res.success) setMyAccounts(res.myAccounts || []);
      else setError(res?.error || '刷新失败');
    } catch (e) {
      setError(e.message || '刷新失败');
    } finally {
      setLoading(false);
    }
  };

  // 删除账号
  const handleRemove = async (acc) => {
    if (!confirm(`确定移除「${acc.nickname}」吗？移除后将无法再查看其作品的播放量。`)) return;
    try {
      const res = await window.electronAPI.myAccountRemove(acc.uid);
      if (res && res.success) {
        setMyAccounts(res.myAccounts || []);
        setWorksByUid(prev => { const n = { ...prev }; delete n[acc.uid]; return n; });
        if (worksModalAccount && worksModalAccount.uid === acc.uid) setWorksModalAccount(null);
      }
    } catch (e) {
      setError(e.message || '移除失败');
    }
  };

  // 导出作品 Excel（与账号管理/主页下载一致；未加载作品时自动抓取）
  const handleExport = async (acc) => {
    try {
      let works = worksByUid[acc.uid]?.list;
      if (!works || works.length === 0) {
        const res = await window.electronAPI.myAccountWorks(acc.uid);
        if (!res || !res.success) {
          setError(res?.error || '获取作品失败');
          return;
        }
        works = res.works || [];
        setWorksByUid(prev => ({ ...prev, [acc.uid]: { list: works, loading: false, error: null } }));
      }
      if (!works || works.length === 0) {
        setError('该账号暂无作品可导出');
        return;
      }
      await exportVideosToXlsx(works, acc.nickname);
    } catch (e) {
      setError(e.message || '导出失败');
    }
  };

  // 爆款分析：选中的我的账号
  const openAnalysis = () => {
    const accounts = myAccounts
      .filter(a => a.sec_uid)
      .map(a => ({ sec_user_id: a.sec_uid, nickname: a.nickname, avatar: a.avatar, uid: a.uid }));
    if (accounts.length === 0) {
      setError('请先绑定至少一个带有 sec_uid 的账号，再进行爆款分析');
      return;
    }
    setAnalysisGroup({ name: '我的账号', accounts });
  };

  // 作品排序（与账号管理一致）
  const sortedWorks = (acc) => {
    const w = worksByUid[acc.uid];
    if (!w || !w.list) return [];
    const arr = [...w.list];
    if (worksSort === 'digg') arr.sort((a, b) => (b.statistics?.digg_count || 0) - (a.statistics?.digg_count || 0));
    else if (worksSort === 'comment') arr.sort((a, b) => (b.statistics?.comment_count || 0) - (a.statistics?.comment_count || 0));
    else arr.sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
    return arr;
  };

  // 作品弹窗 ESC 关闭
  useEffect(() => {
    if (!worksModalAccount) return;
    const onKey = (e) => { if (e.key === 'Escape') setWorksModalAccount(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [worksModalAccount]);

  return (
    <div className="my-accounts fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon">👤</span>
          我的账号
        </h1>
        <p className="hero-subtitle">
          绑定自己的抖音账号，查看自己作品的播放量等完整数据
        </p>
      </div>

      <div className="card">
        <div className="my-accounts-toolbar">
          <div className="my-accounts-btns">
            <button className="btn btn-primary" onClick={handleBindLogin} disabled={loading}>
              {loading ? <span className="loading-spinner"></span> : <Plus size={16} />}
              绑定新账号
            </button>
            <button className="btn btn-secondary" onClick={handleBindCurrent} disabled={loading}>
              <User size={16} />
              绑定当前登录账号
            </button>
          </div>
          <button className="btn btn-primary" onClick={openAnalysis} disabled={myAccounts.length === 0}>
            <Flame size={16} />
            爆款分析
          </button>
        </div>

        {error && (
          <div className="my-accounts-error">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {myAccounts.length === 0 ? (
          <div className="my-accounts-empty">
            <div className="my-accounts-empty-icon">👤</div>
            <div className="my-accounts-empty-title">还没有绑定任何账号</div>
            <div className="my-accounts-empty-text">
              点「绑定新账号」弹抖音登录窗口完成登录绑定，或用「绑定当前登录账号」把现有的登录账号加进来。
              每个账号用各自的登录态抓取，只有自己的作品才能看到播放量。
            </div>
          </div>
        ) : (
          <div className="accounts-grid">
            {myAccounts.map(acc => {
              return (
                <div key={acc.uid} className="account-card-wrap">
                  <div className="account-card">
                    <div className="account-header">
                      <div
                        className="account-avatar account-avatar-clickable"
                        onClick={() => {
                          if (acc.uid) {
                            window.electronAPI.myAccountWorks(acc.uid).catch(() => {});
                          }
                          setModalAccount(acc);
                        }}
                        title="点击查看增速曲线与作品数据"
                      >
                        {acc.avatar ? (
                          <img src={acc.avatar} alt={acc.nickname} />
                        ) : (
                          <div className="avatar-placeholder"><User size={22} /></div>
                        )}
                        <span className="avatar-trend-badge" title="增速曲线"><TrendingUp size={12} /></span>
                      </div>
                      <div className="account-info">
                        <div className="account-name-row">
                          <h3 className="account-name">{acc.nickname || '未知账号'}</h3>
                          <span className="my-account-play-tag" title="用自己的登录态抓取，可以看到播放量">
                            <Eye size={12} /> 播放量可见
                          </span>
                        </div>
                        <p className="account-id">抖音号: {acc.unique_id || '未设置'} · UID: {acc.uid}</p>
                        {acc.signature && (
                          <p className="account-signature">{acc.signature}</p>
                        )}
                      </div>
                    </div>

                    <div className="account-stats">
                      <div className="stat-item">
                        <div className="stat-label">粉丝</div>
                        <div className="stat-value">{formatNumber(acc.follower_count)}</div>
                      </div>
                      <div className="stat-item">
                        <div className="stat-label">关注</div>
                        <div className="stat-value">{formatNumber(acc.following_count)}</div>
                      </div>
                      <div className="stat-item">
                        <div className="stat-label">获赞</div>
                        <div className="stat-value">{formatNumber(acc.total_favorited)}</div>
                      </div>
                      <div className="stat-item">
                        <div className="stat-label">作品</div>
                        <div className="stat-value">{formatNumber(acc.aweme_count)}</div>
                      </div>
                      <div className="stat-item">
                        <div className="stat-label">喜欢</div>
                        <div className="stat-value">{formatNumber(acc.favoriting_count)}</div>
                      </div>
                    </div>

                    <div className="account-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        title="在浏览器中打开主页"
                        onClick={() => window.electronAPI.openExternalUrl(`https://www.douyin.com/user/${acc.sec_uid}`)}
                      >
                        🌐 浏览器
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleRefresh(acc)}
                        disabled={loading}
                        title="刷新资料与作品快照（供增速曲线/爆款分析使用）"
                      >
                        🔄 刷新
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleExport(acc)}
                        title="导出该账号的作品列表为 Excel（与主页下载/账号管理导出一致）"
                      >
                        📊 导出 Excel
                      </button>
                      <button
                        className="btn btn-primary btn-sm works-toggle-btn"
                        onClick={() => openWorks(acc)}
                        title="在弹窗中查看该账号的作品列表"
                      >
                        <Film size={13} />
                        查看作品
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleRemove(acc)}
                        title="移除账号"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 作品列表弹窗（与账号管理一致；额外带播放量列） */}
      {worksModalAccount && (() => {
        const acc = worksModalAccount;
        const w = worksByUid[acc.uid];
        const list = sortedWorks(acc);
        const diggs = list.map(aw => aw.statistics?.digg_count || 0);
        const maxDigg = Math.max(...diggs, 0);
        const avgDigg = diggs.length > 0 ? (diggs.reduce((a, b) => a + b, 0) / diggs.length) : 0;
        // 批量复制当前已加载作品的链接（每行一条）
        const copyAllLinks = async () => {
          if (!list.length) return;
          try {
            await window.electronAPI.copyText(list.map(aw => `https://www.douyin.com/video/${aw.aweme_id}`).join('\n'));
            setCopyFeedback(`已复制 ${list.length} 条链接`);
          } catch (err) {
            setCopyFeedback('复制失败');
          }
          setTimeout(() => setCopyFeedback(null), 1600);
        };
        return (
          <ModalErrorBoundary onClose={() => setWorksModalAccount(null)}>
            <div className="account-modal-overlay" onClick={() => setWorksModalAccount(null)}>
              <div className="account-modal account-modal-lg" onClick={(e) => e.stopPropagation()}>
                <div className="account-modal-head">
                  <div className="account-modal-title">
                    <div className="account-modal-avatar">
                      {acc.avatar ? (
                        <img src={acc.avatar} alt={acc.nickname} />
                      ) : (
                        <div className="avatar-placeholder"><User size={22} /></div>
                      )}
                    </div>
                    <div>
                      <h3>{acc.nickname || '未知账号'}</h3>
                      <p>抖音号: {acc.unique_id || '未设置'} · 作品列表</p>
                    </div>
                  </div>
                  <button className="account-modal-close" onClick={() => setWorksModalAccount(null)} title="关闭">
                    <X size={18} />
                  </button>
                </div>

                <div className="account-modal-body">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                    <div className="works-sort">
                      {[
                        { id: 'newest', label: '最新' },
                        { id: 'digg', label: '点赞' },
                        { id: 'comment', label: '评论' },
                      ].map((o) => (
                        <button
                          key={o.id}
                          className={`works-sort-chip${worksSort === o.id ? ' active' : ''}`}
                          onClick={() => setWorksSort(o.id)}
                        >
                          {o.id === 'newest' && <Clock size={11} />}
                          {o.id === 'digg' && <TrendingUp size={11} />}
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <button
                      className={`btn btn-sm btn-secondary works-copy-btn${copyFeedback ? ' has-feedback' : ''}`}
                      onClick={copyAllLinks}
                      disabled={!w?.list || w.list.length === 0}
                      title="复制当前已加载的全部作品链接，每行一条"
                    >
                      <Copy size={13} />
                      {copyFeedback || '复制全部链接'}
                    </button>
                  </div>

                  {w?.loading && w?.list?.length === 0 && <div className="works-loading">加载作品中...</div>}
                  {w?.error && (
                    <div className="alert alert-danger" style={{ marginTop: 8 }}>
                      <AlertCircle size={14} />
                      <span>{w.error}</span>
                    </div>
                  )}
                  {!w?.loading && !w?.error && w?.list && w.list.length === 0 && (
                    <div className="works-empty">该账号暂无作品</div>
                  )}
                  {w?.list && w.list.length > 0 && (
                    <div className="works-list">
                      {list.map((aw) => {
                        const st = aw.statistics || {};
                        const digg = st.digg_count || 0;
                        const isHot = (digg >= 50000) ||
                                      (digg >= avgDigg * 2.5 && digg >= 2000) ||
                                      (list.length <= 3 && digg === maxDigg && digg >= 2000);
                        const pubDate = aw.create_time ? new Date(Number(aw.create_time) * 1000).toLocaleDateString('zh-CN') : '';
                        return (
                          <div key={aw.aweme_id} className={`work-item${isHot ? ' work-item-hot' : ''}`} title={aw.desc || '无标题'}>
                            {isHot && <span className="work-hot-badge">🔥 爆款</span>}
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
                                <span title={`播放量: ${(st.play_count || 0).toLocaleString()}`}>👁 {formatNumber(st.play_count)}</span>
                                <span title={`点赞量: ${digg.toLocaleString()}`}>❤ {formatNumber(digg)}</span>
                                <span title={`评论量: ${(st.comment_count || 0).toLocaleString()}`}>💬 {formatNumber(st.comment_count)}</span>
                                <span title={`收藏量: ${(st.collect_count || 0).toLocaleString()}`}>⭐ {formatNumber(st.collect_count)}</span>
                                <span title={`分享量: ${(st.share_count || 0).toLocaleString()}`}>↗ {formatNumber(st.share_count)}</span>
                                {pubDate && <span>· {pubDate}</span>}
                                <span
                                  className="work-link-icon"
                                  title="在浏览器中打开此视频"
                                  onClick={(e) => { e.stopPropagation(); window.electronAPI.openExternalUrl(`https://www.douyin.com/video/${aw.aweme_id}`); }}
                                  style={{ cursor: 'pointer', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', color: 'var(--text-tertiary)' }}
                                >
                                  <ExternalLink size={12} />
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {w?.hasMore && !w?.loading && (
                    <button className="works-more-btn" onClick={() => fetchWorks(acc, w.cursor)}>
                      加载更多
                    </button>
                  )}
                </div>
              </div>
            </div>
          </ModalErrorBoundary>
        );
      })()}

      {/* 增速弹窗（复用账号管理的 AccountGrowthModal，数据来自同步到 accounts 的快照） */}
      {modalAccount && (
        <ModalErrorBoundary onClose={() => setModalAccount(null)}>
          <AccountGrowthModal
            account={{
              sec_user_id: modalAccount.sec_uid || modalAccount.sec_user_id || '',
              nickname: modalAccount.nickname || '未知账号',
              avatar: modalAccount.avatar || '',
              unique_id: modalAccount.unique_id || '未设置',
              follower_count: modalAccount.follower_count || 0,
              following_count: modalAccount.following_count || 0,
              total_favorited: modalAccount.total_favorited || 0,
              aweme_count: modalAccount.aweme_count || 0,
              favoriting_count: modalAccount.favoriting_count || 0,
            }}
            onClose={() => setModalAccount(null)}
          />
        </ModalErrorBoundary>
      )}

      {/* 爆款分析弹窗（复用账号管理的分析组件） */}
      {analysisGroup && (
        <ModalErrorBoundary onClose={() => setAnalysisGroup(null)}>
          <HotVideoAnalysisModal
            groupName={analysisGroup.name}
            accounts={analysisGroup.accounts}
            onClose={() => setAnalysisGroup(null)}
          />
        </ModalErrorBoundary>
      )}
    </div>
  );
}

export default MyAccounts;
