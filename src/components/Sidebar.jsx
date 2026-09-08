import React, { useState, useEffect } from 'react';
import './Sidebar.css';
import {
  Home, Download, User, Radio, MessageSquare, Flame,
  BarChart3, Bell, Database, Cookie, Megaphone, Settings, Film, Share2, Link2, Bookmark, Layers,
} from './icons';

function Sidebar({ currentPage, onPageChange, pythonStatus, adsButtonName }) {
  // 双 Tab 模式：download(普通功能) / operation(运营专区)
  // 根据当前页自动推断所属模式；下载与运营的「我的账号」是独立的两个页面，互不跳转
  const opsPages = ['operation', 'monitor', 'account', 'my-accounts', 'hotboard-ops'];
  const downloadPages = ['home', 'download', 'profile', 'live', 'comment', 'hotboard', 'multiplatform', 'texttool', 'xhs-profile', 'hongguo', 'my-self', 'share', 'universal'];

  const inferMode = (page) => {
    if (opsPages.includes(page)) return 'operation';
    return 'download';
  };

  const [mode, setMode] = useState(inferMode(currentPage));

  // 当前页变化时同步模式（例如从首页跳到关注监控）
  useEffect(() => {
    setMode(inferMode(currentPage));
  }, [currentPage]);

  const handleModeChange = (nextMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    // 切换模式时跳到该模式的默认页
    if (nextMode === 'download') {
      onPageChange('home');
    } else {
      onPageChange('operation');
    }
  };

  // 下载模式菜单
  const downloadMenu = [
    { id: 'home', icon: Home, label: '首页' },
    { id: 'download', icon: Download, label: '下载管理' },
    { id: 'profile', icon: User, label: '主页下载' },
    { id: 'live', icon: Radio, label: '直播下载' },
    { id: 'comment', icon: MessageSquare, label: '评论下载' },
    { id: 'hotboard', icon: Flame, label: '抖音热榜' },
    { id: 'multiplatform', icon: Film, label: '多平台下载' },
    { id: 'texttool', icon: Link2, label: '文本处理' },
    { id: 'xhs-profile', icon: Bookmark, label: '小红书主页' },
    { id: 'hongguo', icon: Film, label: '红果下载' },
    { id: 'my-self', icon: User, label: '我的账号' },
    { id: 'share', icon: Share2, label: '分享软件' },
    { id: 'universal', icon: Layers, label: '通用下载器' },
  ];

  // 运营模式菜单
  const operationMenu = [
    { id: 'operation', icon: BarChart3, label: '运营总览' },
    { id: 'monitor', icon: Bell, label: '关注监控' },
    { id: 'account', icon: Database, label: '账号管理' },
    { id: 'my-accounts', icon: User, label: '我的账号' },
  ];

  // 设置组（始终显示在底部，不分模式）
  const settingsMenu = [
    { id: 'cookie', icon: Cookie, label: '登录平台账号' },
    { id: 'ads', icon: Megaphone, label: adsButtonName || '推广信息' },
    { id: 'settings', icon: Settings, label: '设置' },
  ];

  const currentMenu = mode === 'download' ? downloadMenu : operationMenu;
  const menuTitle = mode === 'download' ? '下载' : '运营';
  const menuAccent = mode === 'operation' ? 'ops' : 'blue';

  const getStatusColor = () => {
    switch (pythonStatus) {
      case 'running': return 'var(--success)';
      case 'stopped': return 'var(--danger)';
      case 'checking': return 'var(--warning)';
      default: return 'var(--text-tertiary)';
    }
  };

  const getStatusText = () => {
    switch (pythonStatus) {
      case 'running': return '运行中';
      case 'stopped': return '已停止';
      case 'checking': return '检查中...';
      default: return '错误';
    }
  };

  return (
    <div className={`sidebar sidebar-mode-${mode}`}>
      {/* 顶部双 Tab 切换 */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab${mode === 'download' ? ' active' : ''}`}
          onClick={() => handleModeChange('download')}
        >
          <Download size={15} />
          <span>下载</span>
        </button>
        <button
          className={`sidebar-tab${mode === 'operation' ? ' active' : ''}`}
          onClick={() => handleModeChange('operation')}
        >
          <BarChart3 size={15} />
          <span>运营专区</span>
        </button>
      </div>

      {/* 主导航区 */}
      <nav className="sidebar-nav">
        {/* 当前模式的菜单项 */}
        <div className="nav-section">
          <div className="nav-section-title">{menuTitle}功能</div>
          {currentMenu.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                className={`nav-item${isActive ? ' active' : ''} nav-accent-${menuAccent}`}
                onClick={() => onPageChange(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* 底部设置组 */}
        <div className="nav-section nav-section-bottom">
          <div className="nav-section-title">系统</div>
          {settingsMenu.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                className={`nav-item${isActive ? ' active' : ''}`}
                onClick={() => onPageChange(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* 底部状态栏 */}
      <div className="sidebar-footer">
        <div className="status-indicator">
          <div
            className="status-dot"
            style={{ backgroundColor: getStatusColor() }}
          />
          <span className="status-text">后端: {getStatusText()}</span>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
