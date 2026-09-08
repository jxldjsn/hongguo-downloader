import React from 'react';
import './TitleBar.css';

const PLATFORMS = [
  ['xiaohongshu', '小红书'],
  ['douyin', '抖音'],
  ['kuaishou', '快手'],
  ['bilibili', '哔哩哔哩'],
];

function LoginStatus({ status }) {
  const state = status?.state || 'checking';
  const text = state === 'logged-in'
    ? '已登录'
    : state === 'error'
      ? '检查失败'
      : state === 'checking'
        ? '检查中'
        : '未登录';
  const symbol = state === 'logged-in' ? '✓' : state === 'error' ? '!' : state === 'checking' ? '…' : '×';

  return (
    <div className={`login-status login-status-${state}`} title={status?.message || text}>
      <span className="login-status-mark" aria-hidden="true">{symbol}</span>
      <span className="login-status-name">{text}</span>
    </div>
  );
}

function TitleBar({ statuses, isMaximized, isCheckingLoginStatus, onCheckLoginStatus, onMinimize, onToggleMaximize, onClose }) {
  return (
    <header className="title-bar">
      <div className="title-bar-brand">抖音多平台下载器</div>
      <div className="title-bar-platforms" aria-label="平台登录状态">
        {PLATFORMS.map(([key, label]) => (
          <div className="title-bar-platform" key={key}>
            <span className="title-bar-platform-name">{label}</span>
            <LoginStatus status={statuses?.[key]} />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="login-status-refresh"
        aria-label="一键检查登录状态"
        title="一键检查登录状态"
        onClick={onCheckLoginStatus}
        disabled={isCheckingLoginStatus}
      >
        <span aria-hidden="true">↻</span>
        <span>{isCheckingLoginStatus ? '检查中…' : '检查登录状态'}</span>
      </button>
      <div className="window-controls">
        <button type="button" className="window-control" aria-label="最小化" title="最小化" onClick={onMinimize}>−</button>
        <button type="button" className="window-control" aria-label={isMaximized ? '还原' : '最大化'} title={isMaximized ? '还原' : '最大化'} onClick={onToggleMaximize}>
          {isMaximized ? '❐' : '□'}
        </button>
        <button type="button" className="window-control close" aria-label="关闭" title="关闭" onClick={onClose}>×</button>
      </div>
    </header>
  );
}

export default TitleBar;
