import React, { useState, useEffect, useMemo } from 'react';
import './Monitor.css';
import TrendChart, { Sparkline } from './TrendChart';
import {
  Bell, Users, Film, Plus, Trash2, RefreshCw, Link2,
  Activity, Clock, Heart, TrendingUp, ExternalLink,
} from './icons';

function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN');
}

function formatCount(n) {
  if (typeof n !== 'number') return '0';
  if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + 'w';
  return String(n);
}

// 计算历史序列的上升速度（最近窗口的斜率，单位：增量/小时）
function growthRate(history, valueKey = 'value', windowHours = 24) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  const now = Date.now();
  const since = now - windowHours * 3600 * 1000;
  const points = history.filter((p) => p.time >= since);
  if (points.length < 2) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  const hours = (last.time - first.time) / 3600000;
  if (hours <= 0) return 0;
  return (last[valueKey] - first[valueKey]) / hours;
}

// 序列首尾差值
function totalDelta(history, valueKey = 'value') {
  if (!Array.isArray(history) || history.length < 2) return 0;
  return history[history.length - 1][valueKey] - history[0][valueKey];
}

function Monitor() {
  const [tab, setTab] = useState('users'); // users | videos | events
  const [users, setUsers] = useState([]);
  const [videos, setVideos] = useState([]);
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState({ enabled: true, intervalMinutes: 10, monitorTypes: { follower: true, new_video: true, video_digg: true }, pushTypes: { follower: true, new_video: true, video_digg: true }, serverChan: { enabled: false, sctkey: '' } });

  const [userInput, setUserInput] = useState('');
  const [videoInput, setVideoInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState(null);
  const [checking, setChecking] = useState(false);

  // 当前在左侧大图区展示的监控项
  // { kind: 'user'|'video', id: secUserId|awemeId }
  const [activeItem, setActiveItem] = useState(null);

  // 排序
  const [userSort, setUserSort] = useState('added'); // added | follower | followerGrowth
  const [videoSort, setVideoSort] = useState('added'); // added | digg | diggGrowth | comment

  // 分组（关注用户 / 关注视频 各一套，复用 account_groups 表，用 scope 区分）
  const [userGroups, setUserGroups] = useState([]);
  const [videoGroups, setVideoGroups] = useState([]);
  const [activeUserGroup, setActiveUserGroup] = useState('all'); // all | ungrouped | groupId
  const [activeVideoGroup, setActiveVideoGroup] = useState('all');
  const [selectedUserGroup, setSelectedUserGroup] = useState(''); // 添加用户时选的分组
  const [selectedVideoGroup, setSelectedVideoGroup] = useState('');
  const [showGroupMgr, setShowGroupMgr] = useState(false); // 'user' | 'video' | false
  const [groupMgrScope, setGroupMgrScope] = useState('monitor_user');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('#6366f1');
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  // 标签筛选：只显示含某标签的项（空字符串=全部）
  const [activeUserTag, setActiveUserTag] = useState('');
  const [activeVideoTag, setActiveVideoTag] = useState('');
  // 备注编辑
  const [editingRemark, setEditingRemark] = useState(null); // {kind, id, value}

  // 【新增】图表模式与维度过滤状态
  const [chartMode, setChartMode] = useState('percent'); // percent | absolute
  const [timeDimension, setTimeDimension] = useState('raw'); // raw | day | week | month
  const [activeVideoMetric, setActiveVideoMetric] = useState('all'); // diggCount | commentCount | all

  // 当切换为“数量”模式时，如果当前是“all”，自动切换到首个单项指标聚焦，防止 Y 轴量程崩溃
  useEffect(() => {
    if (chartMode === 'absolute' && activeVideoMetric === 'all') {
      setActiveVideoMetric('diggCount');
    }
  }, [chartMode, activeVideoMetric]);

  const showMessage = (type, text) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const reloadAll = async () => {
    const [u, v, e, c, ug, vg] = await Promise.all([
      window.electronAPI.monitorListUsers(),
      window.electronAPI.monitorListVideos(),
      window.electronAPI.monitorGetEvents(),
      window.electronAPI.monitorGetConfig(),
      window.electronAPI.groupList('monitor_user'),
      window.electronAPI.groupList('monitor_video'),
    ]);
    setUsers(u || []);
    setVideos(v || []);
    setEvents(e || []);
    if (c) setConfig(c);
    setUserGroups((ug && ug.groups) || []);
    setVideoGroups((vg && vg.groups) || []);
  };

  useEffect(() => {
    reloadAll();

    const updatedHandler = (data) => {
      if (data.users) setUsers(data.users);
      if (data.videos) setVideos(data.videos);
    };
    const eventHandler = (evt) => {
      setEvents((prev) => (prev.some((x) => x.id === evt.id) ? prev : [evt, ...prev].slice(0, 200)));
    };
    const unsubscribeUpdated = window.electronAPI.onMonitorUpdated(updatedHandler);
    const unsubscribeEvent = window.electronAPI.onMonitorEvent(eventHandler);

    return () => {
      unsubscribeUpdated();
      unsubscribeEvent();
    };
  }, []);

  const handleAddUser = async () => {
    if (!userInput.trim()) return;
    setAdding(true);
    try {
      const result = await window.electronAPI.monitorAddUser({ input: userInput.trim(), groupId: selectedUserGroup || null });
      if (result.success) {
        showMessage('success', `✅ 已添加监控：${result.user.nickname}`);
        setUserInput('');
      } else {
        showMessage('error', `❌ ${result.error}`);
      }
    } catch (err) {
      showMessage('error', `❌ ${err.message}`);
    } finally {
      setAdding(false);
    }
  };

  const handleAddVideo = async () => {
    if (!videoInput.trim()) return;
    setAdding(true);
    try {
      const result = await window.electronAPI.monitorAddVideo({ input: videoInput.trim(), groupId: selectedVideoGroup || null });
      if (result.success) {
        showMessage('success', `✅ 已添加监控视频`);
        setVideoInput('');
      } else {
        showMessage('error', `❌ ${result.error}`);
      }
    } catch (err) {
      showMessage('error', `❌ ${err.message}`);
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveUser = async (secUserId) => {
    await window.electronAPI.monitorRemoveUser(secUserId);
    setUsers((prev) => prev.filter((u) => u.secUserId !== secUserId));
    if (activeItem && activeItem.kind === 'user' && activeItem.id === secUserId) {
      setActiveItem(null);
    }
  };

  const handleRemoveVideo = async (awemeId) => {
    await window.electronAPI.monitorRemoveVideo(awemeId);
    setVideos((prev) => prev.filter((v) => v.awemeId !== awemeId));
    if (activeItem && activeItem.kind === 'video' && activeItem.id === awemeId) {
      setActiveItem(null);
    }
  };

  const handleToggleUserNotify = async (user, field) => {
    const next = !user[field];
    setUsers((prev) => prev.map((u) => (u.secUserId === user.secUserId ? { ...u, [field]: next } : u)));
    await window.electronAPI.monitorUpdateUser({ secUserId: user.secUserId, [field]: next });
  };

  const handleCheckNow = async () => {
    setChecking(true);
    const result = await window.electronAPI.monitorCheckNow();
    if (!result.success) showMessage('error', result.error);
    else showMessage('success', '已触发检查，结果稍后更新');
    setTimeout(() => setChecking(false), 2000);
  };

  const handleConfigChange = async (patch) => {
    const next = { ...config, ...patch };
    setConfig(next);
    await window.electronAPI.monitorSetConfig(next);
  };

  const handleClearEvents = async () => {
    await window.electronAPI.monitorClearEvents();
    setEvents([]);
  };

  // 按分组 + 标签过滤后的用户列表
  const filteredUsers = useMemo(() => {
    let arr = users;
    if (activeUserGroup === 'ungrouped') arr = arr.filter((u) => !u.groupId);
    else if (activeUserGroup !== 'all') arr = arr.filter((u) => u.groupId === activeUserGroup);
    if (activeUserTag) arr = arr.filter((u) => Array.isArray(u.tags) && u.tags.includes(activeUserTag));
    return arr;
  }, [users, activeUserGroup, activeUserTag]);

  // 排序后的用户列表（置顶优先，再按选定排序）
  const sortedUsers = useMemo(() => {
    const arr = [...filteredUsers];
    if (userSort === 'follower') {
      arr.sort((a, b) => (b.followerCount || 0) - (a.followerCount || 0));
    } else if (userSort === 'followerGrowth') {
      arr.sort((a, b) => growthRate(b.followerHistory) - growthRate(a.followerHistory));
    } else {
      arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }
    // 置顶项排到最前
    arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return arr;
  }, [filteredUsers, userSort]);

  // 按分组 + 标签过滤后的视频列表
  const filteredVideos = useMemo(() => {
    let arr = videos;
    if (activeVideoGroup === 'ungrouped') arr = arr.filter((v) => !v.groupId);
    else if (activeVideoGroup !== 'all') arr = arr.filter((v) => v.groupId === activeVideoGroup);
    if (activeVideoTag) arr = arr.filter((v) => Array.isArray(v.tags) && v.tags.includes(activeVideoTag));
    return arr;
  }, [videos, activeVideoGroup, activeVideoTag]);

  // 排序后的视频列表（置顶优先）
  const sortedVideos = useMemo(() => {
    const arr = [...filteredVideos];
    if (videoSort === 'digg') {
      arr.sort((a, b) => (b.diggCount || 0) - (a.diggCount || 0));
    } else if (videoSort === 'diggGrowth') {
      arr.sort((a, b) => growthRate(b.statsHistory, 'diggCount') - growthRate(a.statsHistory, 'diggCount'));
    } else if (videoSort === 'comment') {
      arr.sort((a, b) => (b.commentCount || 0) - (a.commentCount || 0));
    } else {
      arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }
    arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return arr;
  }, [filteredVideos, videoSort]);

  // 所有标签汇总（用于标签筛选下拉）
  const allUserTags = useMemo(() => {
    const s = new Set();
    users.forEach((u) => Array.isArray(u.tags) && u.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [users]);
  const allVideoTags = useMemo(() => {
    const s = new Set();
    videos.forEach((v) => Array.isArray(v.tags) && v.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [videos]);

  // 分组名映射
  const userGroupNameMap = useMemo(() => {
    const m = {}; userGroups.forEach((g) => { m[g.id] = g.name; }); return m;
  }, [userGroups]);
  const videoGroupNameMap = useMemo(() => {
    const m = {}; videoGroups.forEach((g) => { m[g.id] = g.name; }); return m;
  }, [videoGroups]);

  // 分组 CRUD（复用 account_groups，按 scope）
  const handleAddGroup = async (scope) => {
    const name = scope === 'monitor_user' ? newGroupName : newGroupName;
    if (!name.trim()) return;
    try {
      const res = await window.electronAPI.groupAdd({ name: name.trim(), color: newGroupColor, scope });
      if (res && res.success) {
        if (scope === 'monitor_user') setUserGroups(res.groups || []);
        else setVideoGroups(res.groups || []);
        setNewGroupName('');
        setNewGroupColor('#6366f1');
      } else {
        showMessage('error', res?.error || '新建分组失败');
      }
    } catch (err) { showMessage('error', err.message); }
  };
  const handleRenameGroup = async (id, scope) => {
    if (!editingGroupName.trim()) return;
    try {
      const res = await window.electronAPI.groupRename(id, editingGroupName.trim());
      if (res && res.success) {
        if (scope === 'monitor_user') setUserGroups(res.groups || []);
        else setVideoGroups(res.groups || []);
        setEditingGroupId(null);
      }
    } catch (err) { showMessage('error', err.message); }
  };
  const handleRemoveGroup = async (id, scope) => {
    if (!confirm('删除分组后，组内成员将归入"未分组"，确认删除？')) return;
    try {
      const res = await window.electronAPI.groupRemove(id);
      if (res && res.success) {
        if (scope === 'monitor_user') {
          setUserGroups(res.groups || []);
          setUsers(res.users || []);
          if (activeUserGroup === id) setActiveUserGroup('all');
        } else {
          setVideoGroups(res.groups || []);
          setVideos(res.videos || []);
          if (activeVideoGroup === id) setActiveVideoGroup('all');
        }
      } else {
        showMessage('error', res?.error || '删除分组失败');
      }
    } catch (err) { showMessage('error', err.message); }
  };
  const handleUpdateGroupColor = async (id, color, scope) => {
    try {
      const res = await window.electronAPI.groupUpdateColor(id, color);
      if (res && res.success) {
        if (scope === 'monitor_user') setUserGroups(res.groups || []);
        else setVideoGroups(res.groups || []);
      }
    } catch (err) { /* ignore */ }
  };
  // 移动监控用户/视频到分组
  const handleMoveUser = async (secUserId, groupId) => {
    try {
      const res = await window.electronAPI.groupMoveMonitorUser(secUserId, groupId || null);
      if (res && res.success) setUsers(res.users || []);
    } catch (err) { console.error('移动失败:', err); }
  };
  const handleMoveVideo = async (awemeId, groupId) => {
    try {
      const res = await window.electronAPI.groupMoveMonitorVideo(awemeId, groupId || null);
      if (res && res.success) setVideos(res.users ? [] : (res.videos || []));
    } catch (err) { console.error('移动失败:', err); }
  };
  // 更新备注/标签/置顶
  const handleUpdateUserMeta = async (secUserId, patch) => {
    try {
      const res = await window.electronAPI.monitorUpdateUserMeta(secUserId, patch);
      if (res && res.success) setUsers(res.users || []);
    } catch (err) { console.error('更新失败:', err); }
  };
  const handleUpdateVideoMeta = async (awemeId, patch) => {
    try {
      const res = await window.electronAPI.monitorUpdateVideoMeta(awemeId, patch);
      if (res && res.success) setVideos(res.videos || []);
    } catch (err) { console.error('更新失败:', err); }
  };
  // 切换置顶
  const toggleUserPin = (u) => handleUpdateUserMeta(u.secUserId, { pinned: !u.pinned });
  const toggleVideoPin = (v) => handleUpdateVideoMeta(v.awemeId, { pinned: !v.pinned });

  // 红点只统计「推送开关开启」类型的未读事件（推送关闭的类型不计入红点）
  const unreadCount = events.filter((e) => !e.read && (!e.type || config.pushTypes?.[e.type] !== false)).length;

  // 事件类型定义（与后端 main.js / database.js 一致）
  const EVENT_TYPES = [
    { id: 'follower', label: '粉丝变化' },
    { id: 'new_video', label: '新作品发布' },
    { id: 'video_digg', label: '视频点赞变化' },
  ];

  const handleToggleMonitorType = (type) => {
    const next = { ...(config.monitorTypes || {}), [type]: !config.monitorTypes?.[type] };
    handleConfigChange({ monitorTypes: next });
  };
  const handleTogglePushType = (type) => {
    const next = { ...(config.pushTypes || {}), [type]: !config.pushTypes?.[type] };
    handleConfigChange({ pushTypes: next });
  };

  // ===== Server酱 微信推送 =====
  const [scKeyInput, setScKeyInput] = useState('');
  const [testing, setTesting] = useState(false);

  // 同步配置中的 sctkey 到输入框
  useEffect(() => {
    if (config.serverChan?.sctkey !== undefined) setScKeyInput(config.serverChan.sctkey);
  }, [config.serverChan?.sctkey]);

  const handleToggleServerChan = (e) => {
    handleConfigChange({ serverChan: { ...config.serverChan, enabled: e.target.checked, sctkey: scKeyInput } });
  };

  const handleSaveScKey = () => {
    handleConfigChange({ serverChan: { ...config.serverChan, sctkey: scKeyInput.trim() } });
    showMessage('success', '✓ SendKey 已保存');
  };

  const handleTestPush = async () => {
    if (!scKeyInput.trim()) {
      showMessage('error', '❌ 请先填写 SendKey');
      return;
    }
    setTesting(true);
    try {
      const result = await window.electronAPI.testServerChan({ sctkey: scKeyInput.trim() });
      if (result.success) {
        showMessage('success', '✓ 测试推送已发送，请到微信查看');
      } else {
        showMessage('error', `❌ ${result.error || '推送失败'}`);
      }
    } catch (err) {
      showMessage('error', `❌ ${err.message}`);
    } finally {
      setTimeout(() => setTesting(false), 2000);
    }
  };

  const tabs = [
    { id: 'users', icon: Users, label: '关注用户', count: users.length },
    { id: 'videos', icon: Film, label: '关注视频', count: videos.length },
    { id: 'events', icon: Bell, label: '动态通知', count: events.length, alert: unreadCount },
  ];

  const handleTabChange = async (nextTab) => {
    setTab(nextTab);
    if (nextTab !== 'events') return;
    try {
      const result = await window.electronAPI.monitorMarkEventsRead();
      if (result?.success) {
        setEvents((previous) => previous.map((event) => ({ ...event, read: true })));
      } else {
        showMessage('error', result?.error || '动态已读状态保存失败');
      }
    } catch (error) {
      showMessage('error', error.message || '动态已读状态保存失败');
    }
  };

  const sortOptions = {
    users: [
      { id: 'added', label: '最近添加' },
      { id: 'follower', label: '粉丝数' },
      { id: 'followerGrowth', label: '粉丝增速' },
    ],
    videos: [
      { id: 'added', label: '最近添加' },
      { id: 'digg', label: '点赞数' },
      { id: 'diggGrowth', label: '点赞增速' },
      { id: 'comment', label: '评论数' },
    ],
  };

  // 计算当前大图区要展示的内容
  const activeUser = activeItem && activeItem.kind === 'user'
    ? users.find((u) => u.secUserId === activeItem.id)
    : null;
  const activeVideo = activeItem && activeItem.kind === 'video'
    ? videos.find((v) => v.awemeId === activeItem.id)
    : null;

  // 默认选中第一项（当切换 tab 且没有选中项时）
  useEffect(() => {
    if (tab === 'users' && !activeUser && sortedUsers.length > 0) {
      setActiveItem({ kind: 'user', id: sortedUsers[0].secUserId });
    } else if (tab === 'videos' && !activeVideo && sortedVideos.length > 0) {
      setActiveItem({ kind: 'video', id: sortedVideos[0].awemeId });
    }
  }, [tab, sortedUsers, sortedVideos]); // eslint-disable-line react-hooks/exhaustive-deps

  // 按时间维度聚合数据
  const aggregateHistory = (data, dimension) => {
    if (!Array.isArray(data) || data.length === 0) return [];
    if (dimension === 'raw') {
      const cutoff = Date.now() - 48 * 3600 * 1000;
      return data.filter(d => d.time >= cutoff);
    }
    const groups = {};
    data.forEach(item => {
      const date = new Date(item.time);
      let key;
      if (dimension === 'day') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      } else if (dimension === 'week') {
        const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
        const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
        const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
        key = `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      } else if (dimension === 'month') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }
      if (!groups[key] || item.time > groups[key].time) {
        groups[key] = item;
      }
    });
    return Object.values(groups).sort((a, b) => a.time - b.time);
  };

  const aggregatedUserHistory = useMemo(() => {
    if (!activeUser || !activeUser.followerHistory) return [];
    return aggregateHistory(activeUser.followerHistory, timeDimension);
  }, [activeUser, timeDimension]);

  const aggregatedVideoHistory = useMemo(() => {
    if (!activeVideo || !activeVideo.statsHistory) return [];
    return aggregateHistory(activeVideo.statsHistory, timeDimension);
  }, [activeVideo, timeDimension]);

  return (
    <div className="monitor-page fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon"><Bell size={20} /></span>
          关注监控
        </h1>
        <p className="hero-subtitle">监控关注用户的粉丝变化、新作品发布，以及关注视频的数据变化</p>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      {/* 监控配置 */}
      <div className="card monitor-config">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => handleConfigChange({ enabled: e.target.checked })}
          />
          <span>启用自动监控</span>
        </label>
        <label className="config-interval">
          检查间隔：
          <select
            value={config.intervalMinutes}
            onChange={(e) => handleConfigChange({ intervalMinutes: parseInt(e.target.value) })}
          >
            <option value={5}>5 分钟</option>
            <option value={10}>10 分钟</option>
            <option value={30}>30 分钟</option>
            <option value={60}>1 小时</option>
            <option value={180}>3 小时</option>
          </select>
        </label>
        <button className="btn btn-secondary" onClick={handleCheckNow} disabled={checking}>
          <RefreshCw size={14} className={checking ? 'spin' : ''} />
          {checking ? '检查中...' : '立即检查'}
        </button>
      </div>

      {/* 事件类型开关：监控(检测记录) + 推送(弹窗+红点) */}
      <div className="card monitor-types">
        <div className="monitor-types-head">
          <span className="monitor-types-title"><Bell size={14} /> 事件类型设置</span>
          <span className="monitor-types-hint">监控=检测并记录到动态列表 · 推送=右下角系统弹窗 + 应用内红点</span>
        </div>
        <div className="monitor-types-grid">
          <div className="monitor-types-col">
            <div className="monitor-types-col-title">监控（检测记录）</div>
            {EVENT_TYPES.map((et) => (
              <label key={et.id} className="switch-label monitor-types-row">
                <input
                  type="checkbox"
                  checked={!!config.monitorTypes?.[et.id]}
                  onChange={() => handleToggleMonitorType(et.id)}
                />
                <span>{et.label}</span>
              </label>
            ))}
          </div>
          <div className="monitor-types-col">
            <div className="monitor-types-col-title">推送（弹窗 + 红点）</div>
            {EVENT_TYPES.map((et) => (
              <label key={et.id} className="switch-label monitor-types-row">
                <input
                  type="checkbox"
                  checked={!!config.pushTypes?.[et.id]}
                  onChange={() => handleTogglePushType(et.id)}
                  disabled={!config.monitorTypes?.[et.id]}
                />
                <span>{et.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Server酱 微信推送 */}
      <div className="card serverchan-card">
        <div className="serverchan-head">
          <span className="serverchan-title">💬 Server酱 微信推送</span>
          <label className="switch-label">
            <input
              type="checkbox"
              checked={!!config.serverChan?.enabled}
              onChange={handleToggleServerChan}
            />
            <span>启用</span>
          </label>
        </div>
        <div className="serverchan-body">
          <div className="serverchan-input-row">
            <input
              type="text"
              className="form-input"
              placeholder="粘贴 SendKey，例如 SCT73564TGoF1BeFISDpClxvc42A73DGZ"
              value={scKeyInput}
              onChange={(e) => setScKeyInput(e.target.value)}
            />
            <button className="btn btn-secondary" onClick={handleTestPush} disabled={testing}>
              {testing ? '发送中...' : '测试推送'}
            </button>
            <button className="btn" onClick={handleSaveScKey} disabled={!scKeyInput.trim()}>保存</button>
          </div>
          <div className="serverchan-hint">
            到 <span className="serverchan-link" onClick={() => window.electronAPI.openExternalUrl('https://sct.ftqq.com/')}>sct.ftqq.com</span> 注册并绑定微信服务号，
            复制首页的 SendKey 填入。保存后监控事件会同时推送到微信（受上方「推送」开关控制）。
          </div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="monitor-tabs">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              className={`monitor-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => handleTabChange(t.id)}
            >
              <Icon size={15} />
              <span>{t.label}</span>
              <span className={`tab-badge${t.alert ? ' alert' : ''}`}>{t.count}</span>
            </button>
          );
        })}
      </div>

      {/* 用户监控 —— 双栏布局 */}
      {tab === 'users' && (
        <div className="monitor-dual">
          {/* 左侧：醒目添加卡片 + 排序 + 列表 */}
          <div className="monitor-side">
            <div className="add-card">
              <div className="add-card-header">
                <span className="add-card-title">
                  <Plus size={15} />
                  添加关注用户
                </span>
                <span className="add-card-hint">支持主页链接 / 短链 / sec_user_id</span>
              </div>
              <div className="add-row">
                <div className="input-with-icon">
                  <Link2 size={16} className="input-icon" />
                  <input
                    type="text"
                    className="form-input add-input"
                    placeholder="粘贴用户主页链接，例如 https://v.douyin.com/xxxxxx"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleAddUser()}
                  />
                </div>
                <button className="btn add-btn" onClick={handleAddUser} disabled={adding || !userInput.trim()}>
                  <Plus size={16} />
                  {adding ? '添加中...' : '添加监控'}
                </button>
              </div>
              {/* 添加到分组 */}
              <div className="add-group-select">
                <span className="add-group-select-label">添加到分组：</span>
                <select
                  className="form-input group-select"
                  value={selectedUserGroup}
                  onChange={(e) => setSelectedUserGroup(e.target.value)}
                >
                  <option value="">未分组</option>
                  {userGroups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 分组侧边栏：全部 / 未分组 / 各分组 + 管理 */}
            {users.length > 0 && (
              <div className="monitor-group-bar">
                <div className="monitor-group-bar-head">
                  <span className="monitor-group-bar-title">分组</span>
                  <button className="monitor-group-mgr-btn" onClick={() => { setGroupMgrScope('monitor_user'); setShowGroupMgr('user'); }}>管理</button>
                </div>
                <div className="monitor-group-list">
                  <button className={`monitor-group-item${activeUserGroup === 'all' ? ' active' : ''}`} onClick={() => setActiveUserGroup('all')}>
                    <span className="monitor-group-item-name">全部</span>
                    <span className="monitor-group-item-count">{users.length}</span>
                  </button>
                  <button className={`monitor-group-item${activeUserGroup === 'ungrouped' ? ' active' : ''}`} onClick={() => setActiveUserGroup('ungrouped')}>
                    <span className="monitor-group-item-name">未分组</span>
                    <span className="monitor-group-item-count">{users.filter((u) => !u.groupId).length}</span>
                  </button>
                  {userGroups.map((g) => (
                    <button
                      key={g.id}
                      className={`monitor-group-item${activeUserGroup === g.id ? ' active' : ''}`}
                      onClick={() => setActiveUserGroup(g.id)}
                      title={g.name}
                    >
                      {g.color && <span className="monitor-group-color-dot" style={{ background: g.color }} />}
                      <span className="monitor-group-item-name">{g.name}</span>
                      <span className="monitor-group-item-count">{users.filter((u) => u.groupId === g.id).length}</span>
                    </button>
                  ))}
                </div>
                {/* 标签筛选 */}
                {allUserTags.length > 0 && (
                  <div className="monitor-tag-filter">
                    <span className="monitor-tag-filter-label">标签筛选：</span>
                    <select className="form-input monitor-tag-select" value={activeUserTag} onChange={(e) => setActiveUserTag(e.target.value)}>
                      <option value="">全部标签</option>
                      {allUserTags.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {users.length > 0 && (
              <div className="sort-bar">
                <span className="sort-label"><TrendingUp size={13} /> 排序</span>
                {sortOptions.users.map((o) => (
                  <button
                    key={o.id}
                    className={`sort-chip${userSort === o.id ? ' active' : ''}`}
                    onClick={() => setUserSort(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            {users.length === 0 ? (
              <div className="empty-state-v2">
                <div className="empty-icon-wrap">
                  <Users size={40} />
                </div>
                <div className="empty-title">还没有监控任何用户</div>
                <div className="empty-text">在上方粘贴一个博主主页链接，开始监控他的粉丝与新作品</div>
              </div>
            ) : (
              <div className="monitor-list">
                {sortedUsers.map((u) => {
                  const isActive = activeUser && activeUser.secUserId === u.secUserId;
                  const growth = growthRate(u.followerHistory);
                  const delta = totalDelta(u.followerHistory);
                  return (
                    <div
                      key={u.secUserId}
                      className={`monitor-item ${isActive ? 'active' : ''}${u.pinned ? ' is-pinned' : ''}`}
                      onClick={() => setActiveItem({ kind: 'user', id: u.secUserId })}
                      role="button"
                      tabIndex={0}
                    >
                      {u.avatar
                        ? <img className="monitor-avatar" src={u.avatar} alt="" />
                        : <div className="monitor-avatar placeholder">{(u.nickname || '?').slice(0, 1)}</div>}
                      <div className="monitor-item-main">
                        <div className="monitor-item-title-row">
                          {u.pinned && <span className="monitor-pin-flag" title="已置顶">📌</span>}
                          <span className="monitor-item-title">{u.nickname}</span>
                          {u.groupId && userGroupNameMap[u.groupId] && (
                            <span className="monitor-group-tag" title="所属分组">{userGroupNameMap[u.groupId]}</span>
                          )}
                          {Array.isArray(u.tags) && u.tags.map((t) => (
                            <span key={t} className="monitor-tag-chip" title="标签">{t}</span>
                          ))}
                        </div>
                        {u.remark && <div className="monitor-remark" title="备注">{u.remark}</div>}
                        <div className="stat-chips">
                          <span className="stat-chip"><b>{formatCount(u.followerCount)}</b> 粉丝</span>
                          {delta !== 0 && (
                            <span className={`stat-chip stat-chip-delta${delta > 0 ? ' up' : ' down'}`}>
                              {delta > 0 ? '+' : ''}{formatCount(delta)}
                            </span>
                          )}
                          {growth !== 0 && (
                            <span className={`stat-chip stat-chip-delta${growth > 0 ? ' up' : ' down'}`}>
                              {growth > 0 ? '+' : ''}{formatCount(Math.round(growth))}/h
                            </span>
                          )}
                        </div>
                        {/* 分组/置顶/备注 操作行 */}
                        <div className="monitor-item-actions" onClick={(e) => e.stopPropagation()}>
                          <select
                            className="form-input monitor-move-select"
                            value={u.groupId || ''}
                            onChange={(e) => handleMoveUser(u.secUserId, e.target.value)}
                            title="移动到分组"
                          >
                            <option value="">未分组</option>
                            {userGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                          <button className="icon-btn-mini" title={u.pinned ? '取消置顶' : '置顶'} onClick={() => toggleUserPin(u)}>
                            📌
                          </button>
                          <button
                            className="icon-btn-mini"
                            title="编辑备注/标签"
                            onClick={() => setEditingRemark({ kind: 'user', id: u.secUserId, value: u.remark || '', tags: Array.isArray(u.tags) ? u.tags.join(', ') : '' })}
                          >
                            ✏️
                          </button>
                        </div>
                      </div>
                      <Sparkline
                        data={u.followerHistory || []}
                        dataKey="value"
                        color="var(--ops-accent)"
                        width={72}
                        height={28}
                      />
                      <button
                        className="icon-btn-browser"
                        title="在浏览器中打开主页"
                        style={{ marginRight: '8px' }}
                        onClick={(e) => { e.stopPropagation(); window.electronAPI.openExternalUrl(`https://www.douyin.com/user/${u.secUserId}`); }}
                      >
                        <ExternalLink size={15} />
                      </button>
                      <button
                        className="icon-btn-danger"
                        title="删除"
                        onClick={(e) => { e.stopPropagation(); handleRemoveUser(u.secUserId); }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 右侧：常驻大图 */}
          <div className="monitor-main">
            {activeUser ? (
              <div className="chart-panel">
                <div className="chart-panel-head">
                  <div className="chart-panel-title">
                    {activeUser.avatar
                      ? <img className="chart-panel-avatar" src={activeUser.avatar} alt="" />
                      : <div className="chart-panel-avatar placeholder">{(activeUser.nickname || '?').slice(0, 1)}</div>}
                    <div>
                      <div className="chart-panel-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {activeUser.nickname}
                        <button
                          className="sort-chip"
                          style={{ padding: '2px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={() => window.electronAPI.openExternalUrl(`https://www.douyin.com/user/${activeUser.secUserId}`)}
                          title="在外部浏览器打开抖音主页"
                        >
                          <ExternalLink size={11} /> 抖音主页
                        </button>
                      </div>
                      <div className="chart-panel-sub">
                        <Clock size={11} /> 更新于 {formatTime(activeUser.lastChecked)}
                      </div>
                    </div>
                  </div>
                  <div className="chart-panel-stats">
                    <div className="big-stat">
                      <span className="big-stat-val" title={`粉丝数: ${(activeUser.followerCount || 0).toLocaleString()}`}>{(activeUser.followerCount || 0).toLocaleString()}</span>
                      <span className="big-stat-label">粉丝</span>
                    </div>
                    <div className="big-stat">
                      <span className="big-stat-val" title={`作品数: ${(activeUser.awemeCount || 0).toLocaleString()}`}>{(activeUser.awemeCount || 0).toLocaleString()}</span>
                      <span className="big-stat-label">作品</span>
                    </div>
                    {totalDelta(activeUser.followerHistory) !== 0 && (() => {
                      const delta = totalDelta(activeUser.followerHistory);
                      return (
                        <div className={`big-stat ${delta > 0 ? 'up' : 'down'}`}>
                          <span className="big-stat-val" title={`累计变化: ${delta.toLocaleString()}`}>
                            {delta > 0 ? '+' : ''}{delta.toLocaleString()}
                          </span>
                          <span className="big-stat-label">累计变化</span>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* 时间维度选择器 */}
                <div className="chart-mode-selectors" style={{ display: 'flex', gap: '8px', padding: '0 24px 16px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginRight: '4px' }}>时间维度:</span>
                  <button
                    className={`sort-chip${timeDimension === 'raw' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('raw')}
                    title="显示实时采样数据（展示最近48小时）"
                  >实时</button>
                  <button
                    className={`sort-chip${timeDimension === 'day' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('day')}
                    title="按天汇总展示趋势"
                  >天</button>
                  <button
                    className={`sort-chip${timeDimension === 'week' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('week')}
                    title="按周汇总展示趋势"
                  >周</button>
                  <button
                    className={`sort-chip${timeDimension === 'month' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('month')}
                    title="按月汇总展示趋势"
                  >月</button>
                </div>

                <div className="chart-panel-chart">
                  {aggregatedUserHistory.length >= 2 ? (
                    <TrendChart
                      data={aggregatedUserHistory}
                      series={[{ key: 'value', name: '粉丝', color: 'var(--ops-accent)' }]}
                      mode="area"
                      height={320}
                    />
                  ) : (
                    <div className="chart-panel-empty" style={{ height: 320 }}>
                      <TrendingUp size={36} />
                      <div className="chart-panel-empty-title" style={{ fontSize: 13, marginTop: 12 }}>数据点不足，需至少 2 个采样点</div>
                      {timeDimension !== 'raw' && (
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                          （当前选择的是『{timeDimension === 'day' ? '天' : timeDimension === 'week' ? '周' : '月'}』维度，需要更长时间跨度的数据积累）
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="detail-toggles">
                  <label className="switch-label">
                    <input type="checkbox" checked={!!activeUser.notifyFollower} onChange={() => handleToggleUserNotify(activeUser, 'notifyFollower')} />
                    <span>粉丝变化通知</span>
                  </label>
                  <label className="switch-label">
                    <input type="checkbox" checked={!!activeUser.notifyNewVideo} onChange={() => handleToggleUserNotify(activeUser, 'notifyNewVideo')} />
                    <span>新作品通知</span>
                  </label>
                </div>
              </div>
            ) : (
              <div className="chart-panel chart-panel-empty">
                <Activity size={48} />
                <div className="chart-panel-empty-title">选中左侧列表项查看趋势曲线</div>
                <div className="chart-panel-empty-text">点击任意用户，这里会显示粉丝增长的大图</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 视频监控 —— 双栏布局 */}
      {tab === 'videos' && (
        <div className="monitor-dual">
          <div className="monitor-side">
            <div className="add-card">
              <div className="add-card-header">
                <span className="add-card-title">
                  <Plus size={15} />
                  添加关注视频
                </span>
                <span className="add-card-hint">支持视频链接 / 短链 / 作品ID</span>
              </div>
              <div className="add-row">
                <div className="input-with-icon">
                  <Link2 size={16} className="input-icon" />
                  <input
                    type="text"
                    className="form-input add-input"
                    placeholder="粘贴作品链接，例如 https://v.douyin.com/xxxxxx"
                    value={videoInput}
                    onChange={(e) => setVideoInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleAddVideo()}
                  />
                </div>
                <button className="btn add-btn" onClick={handleAddVideo} disabled={adding || !videoInput.trim()}>
                  <Plus size={16} />
                  {adding ? '添加中...' : '添加监控'}
                </button>
              </div>
              <div className="add-group-select">
                <span className="add-group-select-label">添加到分组：</span>
                <select
                  className="form-input group-select"
                  value={selectedVideoGroup}
                  onChange={(e) => setSelectedVideoGroup(e.target.value)}
                >
                  <option value="">未分组</option>
                  {videoGroups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {videos.length > 0 && (
              <div className="monitor-group-bar">
                <div className="monitor-group-bar-head">
                  <span className="monitor-group-bar-title">分组</span>
                  <button className="monitor-group-mgr-btn" onClick={() => { setGroupMgrScope('monitor_video'); setShowGroupMgr('video'); }}>管理</button>
                </div>
                <div className="monitor-group-list">
                  <button className={`monitor-group-item${activeVideoGroup === 'all' ? ' active' : ''}`} onClick={() => setActiveVideoGroup('all')}>
                    <span className="monitor-group-item-name">全部</span>
                    <span className="monitor-group-item-count">{videos.length}</span>
                  </button>
                  <button className={`monitor-group-item${activeVideoGroup === 'ungrouped' ? ' active' : ''}`} onClick={() => setActiveVideoGroup('ungrouped')}>
                    <span className="monitor-group-item-name">未分组</span>
                    <span className="monitor-group-item-count">{videos.filter((v) => !v.groupId).length}</span>
                  </button>
                  {videoGroups.map((g) => (
                    <button
                      key={g.id}
                      className={`monitor-group-item${activeVideoGroup === g.id ? ' active' : ''}`}
                      onClick={() => setActiveVideoGroup(g.id)}
                      title={g.name}
                    >
                      {g.color && <span className="monitor-group-color-dot" style={{ background: g.color }} />}
                      <span className="monitor-group-item-name">{g.name}</span>
                      <span className="monitor-group-item-count">{videos.filter((v) => v.groupId === g.id).length}</span>
                    </button>
                  ))}
                </div>
                {allVideoTags.length > 0 && (
                  <div className="monitor-tag-filter">
                    <span className="monitor-tag-filter-label">标签筛选：</span>
                    <select className="form-input monitor-tag-select" value={activeVideoTag} onChange={(e) => setActiveVideoTag(e.target.value)}>
                      <option value="">全部标签</option>
                      {allVideoTags.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {videos.length > 0 && (
              <div className="sort-bar">
                <span className="sort-label"><TrendingUp size={13} /> 排序</span>
                {sortOptions.videos.map((o) => (
                  <button
                    key={o.id}
                    className={`sort-chip${videoSort === o.id ? ' active' : ''}`}
                    onClick={() => setVideoSort(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            {videos.length === 0 ? (
              <div className="empty-state-v2">
                <div className="empty-icon-wrap">
                  <Film size={40} />
                </div>
                <div className="empty-title">还没有监控任何视频</div>
                <div className="empty-text">在上方粘贴一个作品链接，跟踪它的点赞与评论变化</div>
              </div>
            ) : (
              <div className="monitor-list">
                {sortedVideos.map((v) => {
                  const isActive = activeVideo && activeVideo.awemeId === v.awemeId;
                  const growth = growthRate(v.statsHistory, 'diggCount');
                  const delta = totalDelta(v.statsHistory, 'diggCount');
                  return (
                    <div
                      key={v.awemeId}
                      className={`monitor-item ${isActive ? 'active' : ''}${v.pinned ? ' is-pinned' : ''}`}
                      onClick={() => setActiveItem({ kind: 'video', id: v.awemeId })}
                      role="button"
                      tabIndex={0}
                    >
                      {v.cover
                        ? <img className="monitor-cover" src={v.cover} alt="" />
                        : <div className="monitor-cover placeholder"><Film size={20} /></div>}
                      <div className="monitor-item-main">
                        <div className="monitor-item-title-row">
                          {v.pinned && <span className="monitor-pin-flag" title="已置顶">📌</span>}
                          <span className="monitor-item-title">{v.desc?.slice(0, 40) || '无标题'}</span>
                          {v.groupId && videoGroupNameMap[v.groupId] && (
                            <span className="monitor-group-tag" title="所属分组">{videoGroupNameMap[v.groupId]}</span>
                          )}
                          {Array.isArray(v.tags) && v.tags.map((t) => (
                            <span key={t} className="monitor-tag-chip" title="标签">{t}</span>
                          ))}
                        </div>
                        {v.author && <div className="monitor-item-author">@{v.author}</div>}
                        {v.remark && <div className="monitor-remark" title="备注">{v.remark}</div>}
                        <div className="stat-chips">
                          <span className="stat-chip"><b>{formatCount(v.diggCount)}</b> 赞</span>
                          <span className="stat-chip"><b>{formatCount(v.commentCount)}</b> 评</span>
                          {growth !== 0 && (
                            <span className={`stat-chip stat-chip-delta${growth > 0 ? ' up' : ' down'}`}>
                              <Heart size={11} /> {growth > 0 ? '+' : ''}{formatCount(Math.round(growth))}/h
                            </span>
                          )}
                        </div>
                        <div className="monitor-item-actions" onClick={(e) => e.stopPropagation()}>
                          <select
                            className="form-input monitor-move-select"
                            value={v.groupId || ''}
                            onChange={(e) => handleMoveVideo(v.awemeId, e.target.value)}
                            title="移动到分组"
                          >
                            <option value="">未分组</option>
                            {videoGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                          <button className="icon-btn-mini" title={v.pinned ? '取消置顶' : '置顶'} onClick={() => toggleVideoPin(v)}>
                            📌
                          </button>
                          <button
                            className="icon-btn-mini"
                            title="编辑备注/标签"
                            onClick={() => setEditingRemark({ kind: 'video', id: v.awemeId, value: v.remark || '', tags: Array.isArray(v.tags) ? v.tags.join(', ') : '' })}
                          >
                            ✏️
                          </button>
                        </div>
                      </div>
                      <Sparkline
                        data={v.statsHistory || []}
                        dataKey="diggCount"
                        color="var(--danger)"
                        width={72}
                        height={28}
                      />
                      <button
                        className="icon-btn-browser"
                        title="在浏览器中打开视频"
                        style={{ marginRight: '8px' }}
                        onClick={(e) => { e.stopPropagation(); window.electronAPI.openExternalUrl(`https://www.douyin.com/video/${v.awemeId}`); }}
                      >
                        <ExternalLink size={15} />
                      </button>
                      <button
                        className="icon-btn-danger"
                        title="删除"
                        onClick={(e) => { e.stopPropagation(); handleRemoveVideo(v.awemeId); }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="monitor-main">
            {activeVideo ? (
              <div className="chart-panel">
                <div className="chart-panel-head">
                  <div className="chart-panel-title">
                    {activeVideo.cover
                      ? <img className="chart-panel-cover" src={activeVideo.cover} alt="" />
                      : <div className="chart-panel-cover placeholder"><Film size={20} /></div>}
                    <div>
                      <div className="chart-panel-name" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        {activeVideo.desc?.slice(0, 30) || '无标题'}
                        <button
                          className="sort-chip"
                          style={{ padding: '2px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={() => window.electronAPI.openExternalUrl(`https://www.douyin.com/video/${activeVideo.awemeId}`)}
                          title="在外部浏览器中打开视频"
                        >
                          <ExternalLink size={11} /> 视频链接
                        </button>
                      </div>
                      <div className="chart-panel-sub">
                        {activeVideo.author && <>@{activeVideo.author} · </>}
                        <Clock size={11} /> {formatTime(activeVideo.lastChecked)}
                      </div>
                    </div>
                  </div>
                  <div className="chart-panel-stats">
                    <div className="big-stat">
                      <span className="big-stat-val" title={`点赞数: ${(activeVideo.diggCount || 0).toLocaleString()}`}>{(activeVideo.diggCount || 0).toLocaleString()}</span>
                      <span className="big-stat-label">点赞</span>
                    </div>
                    <div className="big-stat">
                      <span className="big-stat-val" title={`评论数: ${(activeVideo.commentCount || 0).toLocaleString()}`}>{(activeVideo.commentCount || 0).toLocaleString()}</span>
                      <span className="big-stat-label">评论</span>
                    </div>
                    {totalDelta(activeVideo.statsHistory, 'diggCount') !== 0 && (() => {
                      const delta = totalDelta(activeVideo.statsHistory, 'diggCount');
                      return (
                        <div className={`big-stat ${delta > 0 ? 'up' : 'down'}`}>
                          <span className="big-stat-val" title={`点赞变化: ${delta.toLocaleString()}`}>
                            {delta > 0 ? '+' : ''}{delta.toLocaleString()}
                          </span>
                          <span className="big-stat-label">点赞变化</span>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* 曲线展示与时间维度选择器 */}
                <div className="chart-mode-selectors" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 24px 16px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginRight: '4px' }}>曲线展示:</span>
                    <button
                      className={`sort-chip${chartMode === 'percent' ? ' active' : ''}`}
                      onClick={() => setChartMode('percent')}
                      title="相对首点的增幅百分比，不同量级序列可同图对比趋势"
                    >增幅%</button>
                    <button
                      className={`sort-chip${chartMode === 'absolute' ? ' active' : ''}`}
                      onClick={() => setChartMode('absolute')}
                      title="显示真实数量（不同量级序列可能互相挤压）"
                    >数量</button>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginRight: '4px' }}>时间维度:</span>
                    <button
                      className={`sort-chip${timeDimension === 'raw' ? ' active' : ''}`}
                      onClick={() => setTimeDimension('raw')}
                      title="显示实时采样数据（展示最近48小时）"
                    >实时</button>
                    <button
                      className={`sort-chip${timeDimension === 'day' ? ' active' : ''}`}
                      onClick={() => setTimeDimension('day')}
                      title="按天汇总展示趋势"
                    >天</button>
                    <button
                      className={`sort-chip${timeDimension === 'week' ? ' active' : ''}`}
                      onClick={() => setTimeDimension('week')}
                      title="按周汇总展示趋势"
                    >周</button>
                    <button
                      className={`sort-chip${timeDimension === 'month' ? ' active' : ''}`}
                      onClick={() => setTimeDimension('month')}
                      title="按月汇总展示趋势"
                    >月</button>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginRight: '4px' }}>指标聚焦:</span>
                    <button
                      className={`sort-chip${activeVideoMetric === 'diggCount' ? ' active' : ''}`}
                      onClick={() => setActiveVideoMetric('diggCount')}
                    >❤ 点赞</button>
                    <button
                      className={`sort-chip${activeVideoMetric === 'commentCount' ? ' active' : ''}`}
                      onClick={() => setActiveVideoMetric('commentCount')}
                    >💬 评论</button>
                    {chartMode === 'percent' && (
                      <button
                        className={`sort-chip${activeVideoMetric === 'all' ? ' active' : ''}`}
                        onClick={() => setActiveVideoMetric('all')}
                        title="同时展示点赞与评论的百分比曲线"
                      >对比全部</button>
                    )}
                  </div>
                </div>

                <div className="chart-panel-chart">
                  {aggregatedVideoHistory.length >= 2 ? (
                    <TrendChart
                      data={aggregatedVideoHistory}
                      series={(() => {
                        const allVideoSeries = [
                          { key: 'diggCount', name: '点赞', color: 'var(--danger)' },
                          { key: 'commentCount', name: '评论', color: 'var(--accent)' },
                        ];
                        if (activeVideoMetric === 'all') return allVideoSeries;
                        return allVideoSeries.filter(s => s.key === activeVideoMetric);
                      })()}
                      mode="line"
                      height={320}
                      valueMode={chartMode}
                    />
                  ) : (
                    <div className="chart-panel-empty" style={{ height: 320 }}>
                      <TrendingUp size={36} />
                      <div className="chart-panel-empty-title" style={{ fontSize: 13, marginTop: 12 }}>数据点不足，需至少 2 个采样点</div>
                      {timeDimension !== 'raw' && (
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                          （当前选择的是『{timeDimension === 'day' ? '天' : timeDimension === 'week' ? '周' : '月'}』维度，需要更长时间跨度的数据积累）
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="chart-panel chart-panel-empty">
                <TrendingUp size={48} />
                <div className="chart-panel-empty-title">选中左侧列表项查看趋势曲线</div>
                <div className="chart-panel-empty-text">点击任意视频，这里会显示点赞/评论增长的大图</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 动态通知 */}
      {tab === 'events' && (
        <div className="card">
          <div className="events-header">
            <span>共 {events.length} 条动态</span>
            {events.length > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={handleClearEvents}>清空</button>
            )}
          </div>
          {events.length === 0 ? (
            <div className="empty-state-v2">
              <div className="empty-icon-wrap">
                <Bell size={40} />
              </div>
              <div className="empty-title">暂无动态</div>
              <div className="empty-text">监控到粉丝变化或新作品时，会在这里通知你</div>
            </div>
          ) : (
            <div className="events-list">
              {events.map((e) => (
                <div key={e.id} className={`event-item event-${e.type}`}>
                  <div className="event-icon">
                    {e.type === 'follower' ? <Users size={18} /> : e.type === 'new_video' ? <Film size={18} /> : <Heart size={18} />}
                  </div>
                  <div className="event-body">
                    <div className="event-title">{e.title}</div>
                    <div className="event-message">{e.message}</div>
                    <div className="event-time">{formatTime(e.time)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 分组管理弹窗 */}
      {showGroupMgr && (
        <div className="modal-overlay" onClick={() => setShowGroupMgr(false)}>
          <div className="modal-content group-mgr-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div className="modal-header">
              <h3>管理分组（{showGroupMgr === 'user' ? '关注用户' : '关注视频'}）</h3>
              <button className="modal-close" onClick={() => setShowGroupMgr(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="group-mgr-list">
                {(showGroupMgr === 'user' ? userGroups : videoGroups).length === 0 && (
                  <div className="group-mgr-empty">还没有分组，在下方新建一个吧</div>
                )}
                {(showGroupMgr === 'user' ? userGroups : videoGroups).map((g) => (
                  <div key={g.id} className="group-mgr-item">
                    {editingGroupId === g.id ? (
                      <>
                        <input
                          className="form-input group-mgr-input"
                          value={editingGroupName}
                          onChange={(e) => setEditingGroupName(e.target.value)}
                          autoFocus
                        />
                        <button className="btn btn-primary btn-sm" onClick={() => handleRenameGroup(g.id, groupMgrScope)}>确定</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingGroupId(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <input
                          type="color"
                          className="group-color-picker"
                          value={g.color || '#6366f1'}
                          onChange={(e) => handleUpdateGroupColor(g.id, e.target.value, groupMgrScope)}
                          title="分组颜色"
                        />
                        <span className="group-mgr-name">{g.name}</span>
                        <span className="group-mgr-count">
                          {showGroupMgr === 'user'
                            ? users.filter((u) => u.groupId === g.id).length
                            : videos.filter((v) => v.groupId === g.id).length}
                        </span>
                        <button className="btn btn-secondary btn-sm" onClick={() => { setEditingGroupId(g.id); setEditingGroupName(g.name); }}>重命名</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleRemoveGroup(g.id, groupMgrScope)}>删除</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="group-mgr-add">
                <input
                  className="form-input"
                  placeholder="新分组名称"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
                <input
                  type="color"
                  className="group-color-picker"
                  value={newGroupColor}
                  onChange={(e) => setNewGroupColor(e.target.value)}
                  title="分组颜色"
                />
                <button className="btn btn-primary" onClick={() => handleAddGroup(groupMgrScope)}>新建</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 备注/标签编辑弹窗 */}
      {editingRemark && (
        <div className="modal-overlay" onClick={() => setEditingRemark(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <h3>编辑备注与标签</h3>
              <button className="modal-close" onClick={() => setEditingRemark(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">备注</label>
                <input
                  className="form-input"
                  value={editingRemark.value}
                  onChange={(e) => setEditingRemark({ ...editingRemark, value: e.target.value })}
                  placeholder="给这个{editingRemark.kind === 'user' ? '用户' : '视频'}加个备注"
                />
              </div>
              <div className="form-group">
                <label className="form-label">标签（逗号分隔，可填多个）</label>
                <input
                  className="form-input"
                  value={editingRemark.tags}
                  onChange={(e) => setEditingRemark({ ...editingRemark, tags: e.target.value })}
                  placeholder="例如：重点, 竞品, 待跟进"
                />
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setEditingRemark(null)}>取消</button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const tags = editingRemark.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
                    if (editingRemark.kind === 'user') {
                      handleUpdateUserMeta(editingRemark.id, { remark: editingRemark.value, tags });
                    } else {
                      handleUpdateVideoMeta(editingRemark.id, { remark: editingRemark.value, tags });
                    }
                    setEditingRemark(null);
                  }}
                >保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Monitor;
