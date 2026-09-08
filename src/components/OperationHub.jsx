import React, { useState, useEffect } from 'react';
import './OperationHub.css';
import {
  BarChart3, Bell, Users, Film, Activity, Clock,
  TrendingUp, Database, ChevronRight, RefreshCw, User,
} from './icons';

function OperationHub({ onNavigate }) {
  const [users, setUsers] = useState([]);
  const [videos, setVideos] = useState([]);
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState({ enabled: true, intervalMinutes: 10 });
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const [u, v, e, c] = await Promise.all([
        window.electronAPI?.monitorListUsers?.(),
        window.electronAPI?.monitorListVideos?.(),
        window.electronAPI?.monitorGetEvents?.(),
        window.electronAPI?.monitorGetConfig?.(),
      ]);
      setUsers(u || []);
      setVideos(v || []);
      setEvents(e || []);
      if (c) setConfig(c);
    } catch (err) {
      console.error('[OperationHub] reload failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();

    const updatedHandler = (data) => {
      if (data.users) setUsers(data.users);
      if (data.videos) setVideos(data.videos);
    };
    const eventHandler = (evt) => {
      setEvents((prev) => (prev.some((x) => x.id === evt.id) ? prev : [evt, ...prev].slice(0, 200)));
    };

    const unsubscribeUpdated = window.electronAPI?.onMonitorUpdated?.(updatedHandler);
    const unsubscribeEvent = window.electronAPI?.onMonitorEvent?.(eventHandler);

    return () => {
      unsubscribeUpdated?.();
      unsubscribeEvent?.();
    };
  }, []);

  // 红点只统计「推送开关开启」类型的未读事件（推送关闭的类型不计入红点）
  const unreadCount = events.filter((e) => !e.read && (!e.type || config.pushTypes?.[e.type] !== false)).length;

  const stats = [
    {
      label: '关注用户',
      value: users.length,
      icon: Users,
      color: 'var(--accent)',
      hint: '监控中的博主',
    },
    {
      label: '关注视频',
      value: videos.length,
      icon: Film,
      color: 'var(--ops-accent)',
      hint: '跟踪数据变化',
    },
    {
      label: '未读动态',
      value: unreadCount,
      icon: Bell,
      color: unreadCount > 0 ? 'var(--danger)' : 'var(--text-secondary)',
      hint: unreadCount > 0 ? '有新动态' : '暂无新动态',
      alert: unreadCount > 0,
    },
    {
      label: '监控状态',
      value: config.enabled ? '已启用' : '已暂停',
      icon: Activity,
      color: config.enabled ? 'var(--success)' : 'var(--text-tertiary)',
      hint: `检查间隔 ${config.intervalMinutes} 分钟`,
    },
  ];

  const features = [
    {
      id: 'monitor',
      icon: Bell,
      title: '关注监控',
      desc: '跟踪关注用户的粉丝变化、新作品发布，以及关注视频的数据变化',
      meta: `${users.length} 用户 · ${videos.length} 视频`,
      accent: 'ops',
    },
    {
      id: 'account',
      icon: Database,
      title: '账号管理',
      desc: '账号资料库与数据快照，查看粉丝、关注、获赞、作品等统计，支持导出 CSV',
      meta: '账号资料库',
      accent: 'blue',
    },
    {
      id: 'my-accounts',
      icon: User,
      title: '我的账号',
      desc: '绑定自己的抖音账号（可多个），用各自登录态查看作品的播放量等完整数据',
      meta: '看播放量',
      accent: 'ops',
    },
    {
      id: 'hotboard',
      icon: TrendingUp,
      title: '热门榜单',
      desc: '实时查看抖音热榜、娱乐榜、社会榜及挑战榜，把脉平台流量趋势',
      meta: '流量风向标',
      accent: 'orange',
    },
  ];

  const intervalText = (m) => {
    if (m >= 60) return `${m / 60} 小时`;
    return `${m} 分钟`;
  };

  return (
    <div className="operation-hub fade-in">
      {/* Hero */}
      <div className="hub-hero">
        <div className="hub-hero-text">
          <div className="hub-hero-eyebrow">
            <BarChart3 size={14} />
            <span>OPERATION CENTER</span>
          </div>
          <h1 className="hub-hero-title">运营专区</h1>
          <p className="hub-hero-subtitle">
            集中管理账号监控与数据追踪，第一时间掌握博主粉丝变化、新作品发布与视频数据波动
          </p>
        </div>
        <div className="hub-hero-actions">
          <button className="hub-ghost-btn" onClick={reload} title="刷新数据">
            <RefreshCw size={14} />
            <span>刷新</span>
          </button>
          <div className={`hub-status-pill${config.enabled ? ' on' : ' off'}`}>
            <span className="pill-dot" />
            <span>{config.enabled ? '监控运行中' : '监控已暂停'} · {intervalText(config.intervalMinutes)}</span>
          </div>
        </div>
      </div>

      {/* 数据概览 */}
      <div className="hub-stats">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className={`hub-stat-card${s.alert ? ' hub-stat-alert' : ''}`}>
              <div className="hub-stat-icon" style={{ color: s.color }}>
                <Icon size={20} />
              </div>
              <div className="hub-stat-body">
                <div className="hub-stat-value" style={{ color: s.color }}>{s.value}</div>
                <div className="hub-stat-label">{s.label}</div>
                <div className="hub-stat-hint">{s.hint}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 功能卡片 */}
      <div className="hub-section-title">
        <span>功能入口</span>
      </div>
      <div className="hub-features">
        {features.map((f) => {
          const Icon = f.icon;
          return (
            <button
              key={f.id}
              className={`hub-feature-card accent-${f.accent}`}
              onClick={() => onNavigate?.(f.id)}
            >
              <div className="hub-feature-top">
                <div className="hub-feature-icon">
                  <Icon size={26} />
                </div>
                <ChevronRight size={18} className="hub-feature-arrow" />
              </div>
              <h3 className="hub-feature-title">{f.title}</h3>
              <p className="hub-feature-desc">{f.desc}</p>
              <div className="hub-feature-meta">{f.meta}</div>
            </button>
          );
        })}
      </div>

      {/* 最近动态预览 */}
      <div className="hub-section-title">
        <span>最近动态</span>
        {events.length > 0 && (
          <button className="hub-link-btn" onClick={() => onNavigate?.('monitor')}>
            查看全部 <ChevronRight size={13} />
          </button>
        )}
      </div>
      <div className="hub-events-preview">
        {loading ? (
          <div className="hub-empty">加载中...</div>
        ) : events.length === 0 ? (
          <div className="hub-empty">
            <Bell size={32} className="hub-empty-icon" />
            <div>暂无动态通知</div>
            <div className="hub-empty-sub">监控到变化时会在这里展示</div>
          </div>
        ) : (
          events.slice(0, 5).map((e) => (
            <div key={e.id} className={`hub-event-item event-${e.type}`}>
              <div className="hub-event-icon">
                {e.type === 'follower' ? <Users size={15} /> : e.type === 'new_video' ? <Film size={15} /> : <TrendingUp size={15} />}
              </div>
              <div className="hub-event-body">
                <div className="hub-event-title">{e.title}</div>
                <div className="hub-event-msg">{e.message}</div>
              </div>
              <div className="hub-event-time">
                {e.time ? new Date(e.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default OperationHub;
