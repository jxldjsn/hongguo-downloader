import React, { useState, useEffect } from 'react';
import { aggregateBatch, mergeTaskEvent } from '../utils/downloadUi.mjs';
import './DownloadManager.css';

function DownloadManager({ initialTab, onConsumeTab }) {
  const [downloads, setDownloads] = useState([]);
  const [activeTab, setActiveTab] = useState('all'); // all, downloading, completed, failed
  // 小红书/主页批量下载按 batchId 折叠分组：记录已展开的批次 id
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  // 点击批次卡片打开详情弹窗
  const [modalBatchId, setModalBatchId] = useState(null);
  // 详情弹窗内部分类标签页 ('all' | 'downloading' | 'completed' | 'failed')
  const [modalTab, setModalTab] = useState('all');

  // 主界面列表页码 (每页10条)
  const [mainPage, setMainPage] = useState(1);
  // 弹窗列表页码 (每页10条)
  const [modalPage, setModalPage] = useState(1);
  const PAGE_SIZE = 10;

  // 切换主标签
  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setMainPage(1);
  };

  // 切换弹窗标签
  const handleModalTabChange = (tab) => {
    setModalTab(tab);
    setModalPage(1);
  };

  // 平台代码 -> 中文名（下载列表显示平台标签）
  const PLATFORM_LABELS = {
    douyin: '抖音',
    kuaishou: '快手',
    xiaohongshu: '小红书',
    bilibili: 'B站',
    generic: '通用',
    weibo: '微博',
    pipixia: '皮皮虾',
    xigua: '西瓜',
    weishi: '微视',
    zuiyou: '最右',
    huoshan: '火山',
    quanmin: '度小视',
    lishipin: '梨视频',
    huya: '虎牙',
    acfun: 'A站',
    meipai: '美拍',
    quanminkge: '全民K歌',
    sixroom: '六间房',
    haokan: '好看',
    youtube: 'YouTube',
    hongguo: '红果短剧',
  };

  useEffect(() => {
    const handleTaskAdded = (task) => {
      setDownloads(prev => mergeTaskEvent(prev, task));
      // 新任务加入时回到第 1 页：下载中的任务排在列表最前（isDownloading 优先排序），
      // 若用户停留在分页的后面页会看不到新任务，回到第 1 页才能立即看到
      setMainPage(1);
    };

    const handleProgress = (data) => {
      setDownloads(prev => mergeTaskEvent(prev, {
        ...data,
        status: data.status || 'downloading',
      }));
    };

    const handleCompleted = (data) => {
      setDownloads(prev => mergeTaskEvent(prev, {
        ...data,
        status: 'completed',
        progress: 100,
        savePath: data.path,
        endTime: data.endTime || Date.now(),
      }));
    };

    const handleFailed = (data) => {
      setDownloads(prev => mergeTaskEvent(prev, {
        ...data,
        status: 'failed',
        endTime: data.endTime || Date.now(),
      }));
    };

    const handleStopped = (data) => {
      setDownloads(prev => mergeTaskEvent(prev, {
        ...data,
        status: 'stopped',
        savePath: data.path,
        endTime: data.endTime || Date.now(),
      }));
    };

    const handlePartial = (data) => {
      setDownloads(prev => mergeTaskEvent(prev, {
        ...data,
        status: 'partial',
        savePath: data.path,
        endTime: data.endTime || Date.now(),
      }));
    };

    // 先监听再读取快照，避免加载期间漏掉新任务或完成事件。
    const unsubscribers = [
      window.electronAPI.onDownloadTaskAdded(handleTaskAdded),
      window.electronAPI.onDownloadProgress(handleProgress),
      window.electronAPI.onDownloadCompleted(handleCompleted),
      window.electronAPI.onDownloadFailed(handleFailed),
      window.electronAPI.onDownloadStopped(handleStopped),
      window.electronAPI.onDownloadPartial(handlePartial),
    ].filter(unsubscribe => typeof unsubscribe === 'function');

    let disposed = false;
    const loadTasks = async () => {
      try {
        const tasks = await window.electronAPI.getDownloadTasks();
        if (disposed) return;
        // 先放快照，再重放监听期间已收到的本地状态；较新 revision 会自动胜出。
        setDownloads(prev => prev.reduce(
          (merged, task) => mergeTaskEvent(merged, task),
          Array.isArray(tasks) ? tasks : [],
        ));
      } catch (error) {
        if (!disposed) console.error('加载下载任务失败:', error);
      }
    };
    loadTasks();

    return () => {
      disposed = true;
      unsubscribers.forEach(unsubscribe => unsubscribe());
    };
  }, []);

  // 响应外部传入的初始标签（如首页确认下载后跳「下载中」）
  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
      if (onConsumeTab) onConsumeTab();
    }
  }, [initialTab]);

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // 下载日期：优先用完成时间(endTime)，回退到开始时间(startTime)。
  // 时间戳为毫秒，格式化为 YYYY-MM-DD HH:mm。
  const formatDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // 图集任务：按张数显示进度，而不是字节数
  const isAlbum = (task) => task.type === 'album';
  const isDash = (task) => task.type === 'dash';
  const isM3u8 = (task) => task.type === 'm3u8';
  const isYtdl = (task) => task.type === 'ytdl';
  const isLive = (task) => task.type === 'live';
  // DASH / m3u8 / yt-dlp 任务：多阶段下载，totalBytes=0，按百分比显示进度
  const isMultiPhase = (task) => isDash(task) || isM3u8(task) || isYtdl(task) || isLive(task);
  const formatAlbumProgress = (received, total) => {
    const r = received || 0;
    const t = total || 0;
    return `${r}/${t}张`;
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'parsing': return '解析中';
      case 'pending': return '等待中';
      case 'downloading': return '下载中';
      case 'completed': return '已完成';
      case 'partial': return '部分完成';
      case 'stopped': return '已停止';
      case 'failed': return '失败';
      default: return '未知';
    }
  };

  const getStatusClass = (status) => {
    switch (status) {
      case 'parsing': return 'status-parsing';
      case 'pending': return 'status-pending';
      case 'downloading': return 'status-downloading';
      case 'completed': return 'status-completed';
      case 'partial': return 'status-partial';
      case 'stopped': return 'status-stopped';
      case 'failed': return 'status-failed';
      default: return '';
    }
  };

  // 打开文件所在文件夹
  const openFolder = async (taskId) => {
    try {
      await window.electronAPI.openFolder(taskId);
    } catch (error) {
      console.error('打开文件夹失败:', error);
    }
  };

  // 判断是否音频/音乐地址（图文作品 BGM、音乐提取等场景会出现）：
  // 命中 -ies-music / /music/ 路径、mime_type=audio、或 .mp3 后缀均视为音频
  const isAudioUrl = (u) =>
    /(-ies-music|\/music\/|mime_type=audio|\.mp3(?:\?|$))/i.test(u || '');

  // 取任务的视频链接用于下载管理展示：
  //  优先用作品页面链接（videoInfo.sourceUrl），它稳定且一定是“视频”链接；
  //  没有则退回任务直链 task.url，但要排除占位符（album-data/dash-data 等）和音频地址。
  //  这样主页解析出来的作品会显示作品页链接，而不是会过期/像音频的 CDN 直链。
  const getDownloadLink = (task) => {
    if (!task) return '';
    const source = task.videoInfo && task.videoInfo.sourceUrl;
    if (source && /^https?:\/\//i.test(source) && !isAudioUrl(source)) return source;
    if (!task.url) return '';
    if (!/^https?:\/\//i.test(task.url)) return '';
    // 占位符任务（图集/DASH/m3u8/yt-dlp/评论）不展示直链
    if (/^(album-data|dash-data|m3u8-data|ytdl-data|comment-data)$/.test(task.url)) return '';
    if (isAudioUrl(task.url)) return '';
    return task.url;
  };

  const isAttentionTask = (task) =>
    task.status === 'failed' || task.status === 'partial' || task.status === 'stopped';
  const isAttentionBatchStatus = (status) =>
    status === 'failed' || status === 'partial' || status === 'stopped';

  // 复制链接到剪贴板（含短暂的“已复制”反馈）
  const [copiedId, setCopiedId] = useState(null);
  const copyLink = async (task) => {
    const link = getDownloadLink(task);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(task.id);
      setTimeout(() => setCopiedId((cur) => (cur === task.id ? null : cur)), 1500);
    } catch (error) {
      console.error('复制链接失败:', error);
    }
  };

  // 删除任务
  const deleteTask = async (taskId) => {
    try {
      await window.electronAPI.deleteTask(taskId);
      setDownloads(prev => prev.filter(t => t.id !== taskId));
    } catch (error) {
      console.error('删除任务失败:', error);
    }
  };

  // 展开/折叠小红书批量分组
  const toggleGroup = (batchId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  // 删除整批小红书任务（连同分组）
  const deleteBatch = async (batchId) => {
    const tasksInBatch = downloads.filter(t => t.batchId === batchId);
    if (tasksInBatch.length === 0) return;
    if (!confirm(`确定要删除该用户的 ${tasksInBatch.length} 个任务吗？`)) return;
    try {
      // 批量删除：一次 IPC 传全部 ID
      const ids = tasksInBatch.map(t => t.id);
      const res = await window.electronAPI.deleteTasks(ids);
      if (res && res.success) {
        setDownloads(prev => prev.filter(t => t.batchId !== batchId));
      } else {
        throw new Error((res && res.error) || '删除批次失败');
      }
    } catch (error) {
      console.error('删除批次失败:', error);
    }
  };

  // 停止/暂停下载
  const stopDownload = async (taskId) => {
    try {
      await window.electronAPI.stopDownload(taskId);
    } catch (error) {
      console.error('停止下载失败:', error);
    }
  };

  // 重试单个任务
  const [retrying, setRetrying] = useState(null);
  const retryTask = async (taskId) => {
    setRetrying(taskId);
    try {
      const result = await window.electronAPI.retryTask(taskId);
      if (result && !result.success) {
        console.error('重试失败:', result.error);
        alert('重试失败: ' + (result.error || '未知错误'));
      }
    } catch (error) {
      console.error('重试任务失败:', error);
      alert('重试出错: ' + (error.message || '未知错误'));
    } finally {
      setRetrying(null);
    }
  };

  // 批量重试任务
  const handleBatchRetry = async (targetBatchId = null) => {
    let failedTasks;
    if (targetBatchId) {
      failedTasks = downloads.filter(t => t.batchId === targetBatchId && isAttentionTask(t));
    } else {
      failedTasks = downloads.filter(isAttentionTask);
    }

    const ids = failedTasks.map(t => t.id);
    if (ids.length > 0) {
      try {
        await window.electronAPI.retryTasks(ids);
      } catch (error) {
        console.error('批量重试失败:', error);
      }
    }
  };

  // 批量删除
  const batchDelete = async (type) => {
    let tasksToDelete = [];

    if (type === 'all') {
      tasksToDelete = downloads.map(t => t.id);
    } else if (type === 'completed') {
      tasksToDelete = downloads.filter(t => t.status === 'completed').map(t => t.id);
    } else if (type === 'failed') {
      tasksToDelete = downloads.filter(isAttentionTask).map(t => t.id);
    }

    if (tasksToDelete.length === 0) {
      alert('没有可删除的任务');
      return;
    }

    if (!confirm(`确定要删除 ${tasksToDelete.length} 个任务吗？`)) {
      return;
    }

    try {
      // 批量删除：一次 IPC 传全部 ID，主进程统一处理（避免逐个删除导致 N 次 IPC + N 次 DB 落盘）
      const res = await window.electronAPI.deleteTasks(tasksToDelete);
      if (res && res.success) {
        setDownloads(prev => prev.filter(t => !tasksToDelete.includes(t.id)));
      } else {
        throw new Error((res && res.error) || '批量删除失败');
      }
    } catch (error) {
      console.error('批量删除失败:', error);
    }
  };

  // 统计数量：批次按整体算 1 项（归到整体状态对应的标签），独立任务按各自状态算。
  // counts 在下方分组推导完成后计算（依赖 allBatchOverallStatus）。

  // 单条任务卡片（小红书分组展开后、以及所有独立任务都用它渲染）
  const renderTaskRow = (task, key) => (
    <div key={key} className="card download-item">
      <div className="download-info">
        <div className="download-filename" title={task.filename}>
          {task.platform && (
            <span className="download-platform-badge" title={task.platform}>
              {PLATFORM_LABELS[task.platform] || task.platform}
            </span>
          )}
          {isAlbum(task) && <span className="album-icon">📁</span>}
          {task.filename}
        </div>
        <div className="download-meta">
          <span className={`download-status ${getStatusClass(task.status)}`}>
            {getStatusText(task.status)}
          </span>
          {task.status === 'downloading' && (
            <span className="download-size">
              {isAlbum(task)
                ? formatAlbumProgress(task.receivedBytes, task.totalBytes)
                : (isMultiPhase(task)
                    ? `${task.progress || 0}%`
                    : (task.totalBytes > 0
                        ? `${formatBytes(task.receivedBytes)} / ${formatBytes(task.totalBytes)}`
                        : `已下载: ${formatBytes(task.receivedBytes)}`)
                  )
              }
            </span>
          )}
          {task.status === 'completed' && (
            <>
              <span className="download-size">
                {isAlbum(task)
                  ? `${task.totalBytes || 0}张`
                  : formatBytes(task.totalBytes || task.receivedBytes)
                }
              </span>
              {formatDate(task.endTime || task.startTime) && (
                <span className="download-date" title="下载时间">
                  📅 {formatDate(task.endTime || task.startTime)}
                </span>
              )}
              {task.skipped && (
                <span className="skipped-badge">已跳过</span>
              )}
            </>
          )}
          {task.status === 'stopped' && (
            <>
              <span className="download-size">
                {isAlbum(task)
                  ? `已下载: ${task.receivedBytes || 0}/${task.totalBytes || 0}张`
                  : `已下载: ${formatBytes(task.receivedBytes)}`
                }
              </span>
              {formatDate(task.endTime || task.startTime) && (
                <span className="download-date" title="下载时间">
                  📅 {formatDate(task.endTime || task.startTime)}
                </span>
              )}
            </>
          )}
          {task.status === 'partial' && (
            <>
              <span className="download-size">
                {isAlbum(task)
                  ? `已完成: ${task.receivedBytes || 0}/${task.totalBytes || 0}张`
                  : `已保存: ${formatBytes(task.receivedBytes || task.totalBytes)}`
                }
              </span>
              {formatDate(task.endTime || task.startTime) && (
                <span className="download-date" title="下载时间">
                  📅 {formatDate(task.endTime || task.startTime)}
                </span>
              )}
            </>
          )}
          {(task.status === 'failed' || task.status === 'partial') && task.error && (
            <span className="download-error" title={task.error}>
              {task.error}
            </span>
          )}
          {task.note && (
            <span className="download-note" title={task.note}>
              {task.note}
            </span>
          )}

          {/* 操作按钮 */}
          <div className="download-actions">
            <button
              className="btn-icon"
              onClick={() => openFolder(task.id)}
              title="打开文件夹"
            >
              📁
            </button>
            {isAttentionTask(task) && (
              <button
                className="btn-icon btn-retry"
                onClick={() => retryTask(task.id)}
                title="重新下载此作品"
                disabled={retrying === task.id}
              >
                {retrying === task.id ? <span className="mp-spinner"></span> : '🔄'}
              </button>
            )}
            {task.status === 'downloading' && (
              <button
                className="btn-icon btn-stop"
                onClick={() => stopDownload(task.id)}
                title="停止下载"
              >
                ⏸️
              </button>
            )}
            {(task.status === 'completed' || isAttentionTask(task)) && (
              <button
                className="btn-icon btn-delete"
                onClick={() => deleteTask(task.id)}
                title="删除任务"
              >
                🗑️
              </button>
            )}
          </div>
        </div>

        {/* 下载链接：优先展示作品页面链接（主页解析也会带稳定作品链接），排除音频地址 */}
        {getDownloadLink(task) && (
          <div className="download-link-row">
            <span className="download-link-label">链接:</span>
            <span
              className="download-link-text"
              title={getDownloadLink(task)}
              onClick={() => window.electronAPI.openExternalUrl(getDownloadLink(task))}
            >
              {getDownloadLink(task)}
            </span>
            <button
              className="btn-copy-link"
              onClick={() => copyLink(task)}
              title="复制链接"
            >
              {copiedId === task.id ? '已复制' : '复制'}
            </button>
          </div>
        )}
      </div>

      {(task.status === 'downloading' || task.status === 'pending') && (
        <div className="progress-bar-container">
          {task.totalBytes > 0 || isMultiPhase(task) ? (
            <>
              <div
                className="progress-bar"
                style={{ width: `${task.progress}%` }}
              ></div>
              <span className="progress-text">{task.progress}%</span>
            </>
          ) : (
            <>
              <div className="progress-bar loading-bar"></div>
              <span className="progress-text">录制中...</span>
            </>
          )}
        </div>
      )}

      {/* 解析中：小红书主页批量任务后台解析阶段，显示脉冲加载条 */}
      {task.status === 'parsing' && (
        <div className="progress-bar-container">
          <div className="progress-bar loading-bar"></div>
          <span className="progress-text">解析中...</span>
        </div>
      )}
    </div>
  );

  // 过滤下载任务：
  //  - 独立任务(无 batchId)：按当前标签的状态筛选
  //  - 小红书批量任务(有 batchId)：先整体保留，再由 batchVisibleInTab 按批次整体状态决定是否显示。
  //    不能按单条状态先筛，否则一个批次会被拆散（比如批次整体是"解析中"时，已完成的那几条会被筛掉）。
  const filteredDownloads = downloads.filter(task => {
    if (task.batchId) return true; // 批次任务整组保留，可见性在 batchVisibleInTab 判定
    if (activeTab === 'all') return true;
    if (activeTab === 'downloading') return task.status === 'downloading' || task.status === 'pending' || task.status === 'parsing';
    if (activeTab === 'completed') return task.status === 'completed';
    if (activeTab === 'failed') return isAttentionTask(task);
    return true;
  });

  // 把过滤后的任务拆成两块：小红书批量分组(按 batchId 聚合) + 独立任务(其他平台/单条)
  // 分组顺序按"该批次第一条任务在列表中的位置"保持稳定（创建时同一批相邻入队）
  const batchOrder = [];
  const batchTasks = {};
  const standaloneTasks = [];
  for (const task of filteredDownloads) {
    if (task.batchId) {
      if (!batchTasks[task.batchId]) {
        batchTasks[task.batchId] = [];
        batchOrder.push(task.batchId);
      }
      batchTasks[task.batchId].push(task);
    } else {
      standaloneTasks.push(task);
    }
  }

  // 全量（未按标签过滤）的批次分组 + 独立任务，用于 counts 统计，这样切标签时计数不丢
  const allBatchTasks = {};
  const allStandaloneTasks = [];
  for (const task of downloads) {
    if (task.batchId) {
      if (!allBatchTasks[task.batchId]) allBatchTasks[task.batchId] = [];
      allBatchTasks[task.batchId].push(task);
    } else {
      allStandaloneTasks.push(task);
    }
  }
  const allBatchOverallStatus = (bid) => aggregateBatch(allBatchTasks[bid] || []);

  // 计算某批次的整体进度：已完成数/总数，用于折叠行显示
  const batchProgress = (batchId) => {
    const list = batchTasks[batchId] || [];
    const total = list.length;
    const done = list.filter(t => t.status === 'completed').length;
    const failed = list.filter(isAttentionTask).length;
    const parsing = list.filter(t => t.status === 'parsing').length;
    return { total, done, failed, parsing };
  };

  // 判定批次整体状态（用于折叠行的状态徽标 + 是否整体可见于当前标签）
  const batchOverallStatus = (batchId) => aggregateBatch(batchTasks[batchId] || []);

  // 一个批次在当前标签下是否应显示：
  //  - 全部/下载中/需处理：看整体状态
  //  - 已完成：仅当全部任务都完成才显示（与单条 completed 的语义一致：整批都下完）
  const batchVisibleInTab = (batchId) => {
    const overall = batchOverallStatus(batchId);
    if (activeTab === 'all') return true;
    if (activeTab === 'downloading') return overall === 'parsing' || overall === 'downloading';
    if (activeTab === 'completed') return overall === 'completed';
    if (activeTab === 'failed') return isAttentionBatchStatus(overall);
    return true;
  };

  // 打开批次详情弹窗（同时重置内部分类标签为'all'）
  const openBatchModal = (batchId) => {
    setModalTab('all');
    setModalBatchId(batchId);
  };

  // 渲染一个批次卡片（点击卡片弹窗查看明细列表）
  const renderBatchGroup = (batchId) => {
    const list = batchTasks[batchId];
    if (!list || list.length === 0) return null;
    const info = (list[0] && list[0].batchInfo) || {};
    const { total, done, failed, parsing } = batchProgress(batchId);
    const overall = batchOverallStatus(batchId);
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const nickname = info.nickname || '批量下载作品';
    const profileUrl = info.profileUrl || '';
    const avatar = info.avatar || '';
    const platform = info.platform || 'douyin';
    const firstTask = list[0];

    return (
      <div key={`batch-${batchId}`} className="xhs-batch-group" onClick={() => openBatchModal(batchId)}>
        <div className="xhs-batch-header">
          {avatar ? (
            <img className="xhs-batch-avatar" src={avatar} alt="" onError={(e) => { e.target.style.display = 'none'; }} />
          ) : (
            <span className="xhs-batch-avatar xhs-batch-avatar-placeholder">📁</span>
          )}
          <span className="download-platform-badge" title={platform}>
            {PLATFORM_LABELS[platform] || platform}
          </span>
          <span className="xhs-batch-nickname" title={nickname}>{nickname}</span>
          {profileUrl && (
            <span
              className="xhs-batch-profile-url"
              title={profileUrl}
              onClick={(e) => { e.stopPropagation(); window.electronAPI.openExternalUrl(profileUrl); }}
            >
              主页链接
            </span>
          )}
          <span className={`download-status ${getStatusClass(overall)}`}>
            {getStatusText(overall)}
          </span>
          <span className="xhs-batch-count" title={`完成 ${done}/${total}${failed ? `，需处理 ${failed}` : ''}${parsing ? `，解析中 ${parsing}` : ''}`}>
            {done}/{total}
          </span>
          <div className="xhs-batch-progress" title={`完成 ${percent}%`}>
            <div className="progress-bar" style={{ width: `${percent}%` }}></div>
          </div>
          <div className="xhs-batch-actions">
            {firstTask && (
              <button
                className="btn-icon"
                onClick={(e) => { e.stopPropagation(); openFolder(firstTask.id); }}
                title="打开下载文件夹"
              >
                📁
              </button>
            )}
            <button
              className="btn-icon"
              onClick={(e) => { e.stopPropagation(); openBatchModal(batchId); }}
              title="点击弹窗查看下载详情"
            >
              🔍 详情
            </button>
            {(overall === 'completed' || isAttentionBatchStatus(overall)) && (
              <button
                className="btn-icon btn-delete"
                onClick={(e) => { e.stopPropagation(); deleteBatch(batchId); }}
                title="删除整批"
              >
                🗑️
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // 渲染顺序：优先将正在【下载中/解析中/等待中】的批次与独立任务定位排在最上方！
  const visibleBatches = batchOrder.filter(batchVisibleInTab);

  const displayList = [
    ...visibleBatches.map(batchId => {
      const overall = batchOverallStatus(batchId);
      const isDownloading = overall === 'downloading' || overall === 'parsing';
      const firstTask = (batchTasks[batchId] && batchTasks[batchId][0]) || {};
      return {
        type: 'batch',
        id: batchId,
        isDownloading,
        startTime: firstTask.startTime || 0,
      };
    }),
    ...standaloneTasks.map(task => {
      const isDownloading = task.status === 'downloading' || task.status === 'pending' || task.status === 'parsing';
      return {
        type: 'standalone',
        task,
        isDownloading,
        startTime: task.startTime || 0,
      };
    })
  ].sort((a, b) => {
    // 正在下载中的任务与批次在列表最最上方
    if (a.isDownloading && !b.isDownloading) return -1;
    if (!a.isDownloading && b.isDownloading) return 1;
    // 状态相同者按最新创建时间降序
    return b.startTime - a.startTime;
  });

  // 通用分页渲染组件
  const renderPagination = (currentPage, totalPages, totalItems, onPageChange) => {
    if (totalPages <= 1) return null;

    const pageNumbers = [];
    const maxButtons = 5;
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage < maxButtons - 1) {
      startPage = Math.max(1, endPage - maxButtons + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      pageNumbers.push(i);
    }

    return (
      <div className="pagination-container">
        <div className="pagination-info">
          共 {totalItems} 项 · 第 {currentPage}/{totalPages} 页
        </div>
        <div className="pagination-controls">
          <button
            className="btn-page"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
          >
            上一页
          </button>
          {startPage > 1 && (
            <>
              <button className="btn-page-num" onClick={() => onPageChange(1)}>1</button>
              {startPage > 2 && <span className="pagination-ellipsis">...</span>}
            </>
          )}
          {pageNumbers.map(n => (
            <button
              key={n}
              className={`btn-page-num ${n === currentPage ? 'active' : ''}`}
              onClick={() => onPageChange(n)}
            >
              {n}
            </button>
          ))}
          {endPage < totalPages && (
            <>
              {endPage < totalPages - 1 && <span className="pagination-ellipsis">...</span>}
              <button className="btn-page-num" onClick={() => onPageChange(totalPages)}>{totalPages}</button>
            </>
          )}
          <button
            className="btn-page"
            disabled={currentPage >= totalPages}
            onClick={() => onPageChange(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    );
  };

  const totalVisible = displayList.length;

  // 主列表分页切片
  const mainTotalPages = Math.ceil(displayList.length / PAGE_SIZE) || 1;
  const currentMainPage = Math.min(mainPage, mainTotalPages);
  const pagedDisplayList = displayList.slice((currentMainPage - 1) * PAGE_SIZE, currentMainPage * PAGE_SIZE);

  // 统计数量：批次按整体算 1 项，独立任务按各自状态算。
  // 这样"全部"显示的是「批次数 + 独立任务数」，而不是把批次里每条都算进去，更贴合"一行一个用户"的展示。
  const allBatchIds = Object.keys(allBatchTasks);
  const allBatchOverallList = allBatchIds.map(allBatchOverallStatus);
  const counts = {
    all: allBatchIds.length + allStandaloneTasks.length,
    downloading: allBatchOverallList.filter(s => s === 'parsing' || s === 'downloading').length
      + allStandaloneTasks.filter(t => t.status === 'downloading' || t.status === 'pending' || t.status === 'parsing').length,
    completed: allBatchOverallList.filter(s => s === 'completed').length
      + allStandaloneTasks.filter(t => t.status === 'completed').length,
    failed: allBatchOverallList.filter(isAttentionBatchStatus).length
      + allStandaloneTasks.filter(isAttentionTask).length,
  };

  return (
    <div className="download-manager fade-in">
      <h1 className="page-title">下载管理</h1>

      {/* 标签页和操作按钮 */}
      <div className="tabs-container">
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'all' ? 'tab-active' : ''}`}
            onClick={() => handleTabChange('all')}
          >
            全部 ({counts.all})
          </button>
          <button
            className={`tab ${activeTab === 'downloading' ? 'tab-active' : ''}`}
            onClick={() => handleTabChange('downloading')}
          >
            下载中 ({counts.downloading})
          </button>
          <button
            className={`tab ${activeTab === 'completed' ? 'tab-active' : ''}`}
            onClick={() => handleTabChange('completed')}
          >
            已完成 ({counts.completed})
          </button>
          <button
            className={`tab ${activeTab === 'failed' ? 'tab-active' : ''}`}
            onClick={() => handleTabChange('failed')}
          >
            需处理 ({counts.failed})
          </button>
        </div>

        <div className="batch-actions">
          {counts.failed > 0 && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleBatchRetry()}
              title="批量重新下载失败、部分完成及已停止的任务"
            >
              🔄 批量重试 ({counts.failed})
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => batchDelete('completed')}
            disabled={counts.completed === 0}
          >
            删除已完成
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => batchDelete('failed')}
            disabled={counts.failed === 0}
          >
            删除需处理
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={() => batchDelete('all')}
            disabled={counts.all === 0}
          >
            删除全部
          </button>
        </div>
      </div>

      {totalVisible === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📥</div>
            <div className="empty-state-title">暂无下载任务</div>
            <div className="empty-state-text">
              在首页粘贴链接开始下载，或前往账号管理批量下载
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="download-list">
            {pagedDisplayList.map(item => {
              if (item.type === 'batch') {
                return renderBatchGroup(item.id);
              }
              return renderTaskRow(item.task, item.task.id);
            })}
          </div>
          {renderPagination(currentMainPage, mainTotalPages, totalVisible, (p) => setMainPage(p))}
        </>
      )}

      {/* 点击批次后展开的详情弹窗 */}
      {modalBatchId && (() => {
        const allModalTasks = downloads.filter(t => t.batchId === modalBatchId);
        if (allModalTasks.length === 0) return null;
        const info = allModalTasks[0]?.batchInfo || {};
        const nickname = info.nickname || '批量下载详情';
        const { total, done, failed, parsing } = batchProgress(modalBatchId);
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        const firstTask = allModalTasks[0];

        const modalCounts = {
          all: allModalTasks.length,
          downloading: allModalTasks.filter(t => t.status === 'downloading' || t.status === 'pending' || t.status === 'parsing').length,
          completed: allModalTasks.filter(t => t.status === 'completed').length,
          failed: allModalTasks.filter(isAttentionTask).length,
        };

        const getTaskRank = (t) => {
          if (t.status === 'downloading') return 1;
          if (t.status === 'parsing') return 2;
          if (t.status === 'pending') return 3;
          if (t.status === 'partial') return 4;
          if (t.status === 'failed') return 5;
          if (t.status === 'stopped') return 6;
          if (t.status === 'completed') return 7;
          return 8;
        };

        const visibleModalTasks = allModalTasks.filter(t => {
          if (modalTab === 'all') return true;
          if (modalTab === 'downloading') return t.status === 'downloading' || t.status === 'pending' || t.status === 'parsing';
          if (modalTab === 'completed') return t.status === 'completed';
          if (modalTab === 'failed') return isAttentionTask(t);
          return true;
        }).sort((a, b) => {
          const rA = getTaskRank(a);
          const rB = getTaskRank(b);
          if (rA !== rB) return rA - rB;
          return (b.startTime || 0) - (a.startTime || 0);
        });

        const modalTotalPages = Math.ceil(visibleModalTasks.length / PAGE_SIZE) || 1;
        const currentModalPage = Math.min(modalPage, modalTotalPages);
        const pagedModalTasks = visibleModalTasks.slice((currentModalPage - 1) * PAGE_SIZE, currentModalPage * PAGE_SIZE);

        return (
          <div className="download-modal-overlay" onClick={() => setModalBatchId(null)}>
            <div className="download-modal" onClick={e => e.stopPropagation()}>
              <div className="download-modal-header">
                <div className="download-modal-title">
                  <span className="download-modal-icon">📁</span>
                  <div>
                    <h3>{nickname}</h3>
                    <p className="download-modal-sub">
                      共 {total} 个作品 · 已完成 {done} 个{failed ? ` · 需处理 ${failed} 个` : ''}{parsing ? ` · 解析中 ${parsing} 个` : ''}
                    </p>
                  </div>
                </div>
                <div className="download-modal-header-actions">
                  {modalCounts.failed > 0 && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleBatchRetry(modalBatchId)}
                      title="批量重新下载该文件夹下所有需处理的作品"
                    >
                      🔄 批量重试 ({modalCounts.failed})
                    </button>
                  )}
                  {firstTask && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => openFolder(firstTask.id)}
                      title="打开下载文件夹"
                    >
                      📁 打开文件夹
                    </button>
                  )}
                  <button
                    className="btn-modal-close"
                    onClick={() => setModalBatchId(null)}
                    title="关闭"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="download-modal-progress-bar-wrap">
                <div className="progress-bar" style={{ width: `${percent}%` }}></div>
              </div>

              {/* 弹窗内部分类标签页 */}
              <div className="download-modal-tabs">
                <button
                  className={`modal-tab ${modalTab === 'all' ? 'active' : ''}`}
                  onClick={() => handleModalTabChange('all')}
                >
                  全部 ({modalCounts.all})
                </button>
                <button
                  className={`modal-tab ${modalTab === 'downloading' ? 'active' : ''}`}
                  onClick={() => handleModalTabChange('downloading')}
                >
                  下载中 ({modalCounts.downloading})
                </button>
                <button
                  className={`modal-tab ${modalTab === 'completed' ? 'active' : ''}`}
                  onClick={() => handleModalTabChange('completed')}
                >
                  已完成 ({modalCounts.completed})
                </button>
                <button
                  className={`modal-tab ${modalTab === 'failed' ? 'active' : ''}`}
                  onClick={() => handleModalTabChange('failed')}
                >
                  需处理 ({modalCounts.failed})
                </button>
              </div>

              <div className="download-modal-body">
                {visibleModalTasks.length === 0 ? (
                  <div className="modal-empty-state">
                    该分类下暂无作品任务
                  </div>
                ) : (
                  <>
                    <div className="modal-task-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {pagedModalTasks.map(task => renderTaskRow(task, task.id))}
                    </div>
                    {renderPagination(currentModalPage, modalTotalPages, visibleModalTasks.length, (p) => setModalPage(p))}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default DownloadManager;
