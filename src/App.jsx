import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import { createLoginStatusPoller } from './utils/loginStatusPolling.mjs';
import HomePage from './components/HomePage';
import CookieManager from './components/CookieManager';
import DownloadManager from './components/DownloadManager';
import Settings from './components/Settings';
import AccountManager from './components/AccountManager';
import ProfileDownload from './components/ProfileDownload';
import LiveDownload from './components/LiveDownload';
import CommentDownload from './components/CommentDownload';
import HotBoard from './components/HotBoard';
import Monitor from './components/Monitor';
import AdDisplay from './components/AdDisplay';
import OperationHub from './components/OperationHub';
import MultiPlatformDownload from './components/MultiPlatformDownload';
import TextTool from './components/TextTool';
import ShareSoftware from './components/ShareSoftware';
import UniversalDownload from './components/UniversalDownload';
import XhsProfileDownload from './components/XhsProfileDownload';
import MyAccounts from './components/MyAccounts';
import MySelfDownload from './components/MySelfDownload';
import HongguoDownload from './components/HongguoDownload';

function App() {
  const [currentPage, setCurrentPage] = useState(null); // null表示正在加载配置
  const [pythonStatus, setPythonStatus] = useState('running'); // Always running with native API
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [loginStatuses, setLoginStatuses] = useState({
    xiaohongshu: { state: 'checking', isLoggedIn: false, message: '检查中' },
    douyin: { state: 'checking', isLoggedIn: false, message: '检查中' },
    kuaishou: { state: 'checking', isLoggedIn: false, message: '检查中' },
    bilibili: { state: 'checking', isLoggedIn: false, message: '检查中' },
  });
  const [windowState, setWindowState] = useState({ isMaximized: false });
  const [isCheckingLoginStatus, setIsCheckingLoginStatus] = useState(false);
  const loginStatusPollerRef = useRef(null);
  const [downloadInitialTab, setDownloadInitialTab] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [adsButtonName, setAdsButtonName] = useState('推广信息');
  const [showLoginAlert, setShowLoginAlert] = useState(false); // 未登录提示框
  const [configLoaded, setConfigLoaded] = useState(false); // 配置是否已加载

  useEffect(() => {
    // Check status once to confirm native API
    checkPythonStatus();

    // Check cookie status immediately and then every 60 seconds
    // 登录状态由统一轮询器负责（启动立即检查，之后每 10 分钟）。

    // 启动时执行控制端相关功能
    initControlPanelFeatures();

    return undefined;
  }, []);

  // 初始化控制端功能
  useEffect(() => {
    const applyLoginSummary = (result) => {
      if (result?.success && result.statuses) {
        setLoginStatuses(result.statuses);
        const douyinStatus = result.statuses.douyin;
        if (douyinStatus?.state !== 'logged-in' && !sessionStorage.getItem('login_alert_shown')) {
          setShowLoginAlert(true);
          sessionStorage.setItem('login_alert_shown', 'true');
        }
      }
      return result;
    };

    const poller = createLoginStatusPoller({
      refresh: async () => {
        setIsCheckingLoginStatus(true);
        try {
          return applyLoginSummary(await window.electronAPI.getLoginStatusSummary());
        } finally {
          setIsCheckingLoginStatus(false);
        }
      },
      subscribe: (notify) => window.electronAPI.onLoginStatusChanged(notify),
    });
    loginStatusPollerRef.current = poller;
    const stopPolling = poller.start();
    const removeWindowStateListener = window.electronAPI.onWindowStateChanged((state) => {
      setWindowState({ isMaximized: state?.isMaximized === true });
    });
    window.electronAPI.getWindowState().then((state) => {
      if (state?.success) setWindowState({ isMaximized: state.isMaximized === true });
    }).catch(() => {});

    return () => {
      stopPolling();
      loginStatusPollerRef.current = null;
      if (typeof removeWindowStateListener === 'function') removeWindowStateListener();
    };
  }, []);

  const initControlPanelFeatures = async () => {
    try {
      // 1. IP统计上报
      const ipResult = await window.electronAPI.reportIPToControlPanel();
      if (ipResult.success) {
        console.log('[App] IP已上报:', ipResult.ip);
      } else {
        console.warn('[App] IP上报失败:', ipResult.error);
      }

      // 2. 获取客户端配置（按钮名称、启动时显示推广信息）
      const configResult = await window.electronAPI.getClientConfig();
      console.log('[App] 控制端配置:', configResult);
      if (configResult.success) {
        if (configResult.button_name) {
          setAdsButtonName(configResult.button_name);
        }
        // 根据配置决定启动时显示的页面
        console.log('[App] show_ads_on_startup 值:', configResult.show_ads_on_startup);
        if (configResult.show_ads_on_startup) {
          console.log('[App] 启动时显示推广信息');
          setCurrentPage('ads'); // 显示推广信息
        } else {
          console.log('[App] 启动时显示首页');
          setCurrentPage('home'); // 显示首页
        }
      } else {
        // 获取配置失败，默认显示首页
        console.warn('[App] 获取配置失败，默认显示首页');
        setCurrentPage('home');
      }

      // 3. 检查版本更新
      const versionResult = await window.electronAPI.checkControlPanelVersion();
      if (versionResult.success && versionResult.has_update) {
        setUpdateInfo(versionResult);
        setShowUpdateModal(true);
      }

      // 4. 获取弹窗配置
      const popupResult = await window.electronAPI.getControlPanelPopup();
      if (popupResult.success && popupResult.enabled && popupResult.url) {
        // 打开弹窗URL
        await window.electronAPI.openExternalUrl(popupResult.url);
      }
    } catch (error) {
      console.error('[App] 控制端功能初始化失败:', error);
      // 出错时默认显示首页
      setCurrentPage('home');
    } finally {
      // 标记配置已加载
      setConfigLoaded(true);
    }
  };

  const checkPythonStatus = async () => {
    try {
      const result = await window.electronAPI.checkPythonStatus();
      setPythonStatus(result.running ? 'running' : 'stopped');
      if (result.native) {
        console.log('[App] Using native Node.js API - no Python backend required');
      }
    } catch (error) {
      setPythonStatus('error');
    }
  };

  // 处理更新
  const handleUpdate = async () => {
    if (updateInfo && updateInfo.download_url) {
      await window.electronAPI.openExternalUrl(updateInfo.download_url);
    }
  };

  // 关闭更新弹窗
  const closeUpdateModal = () => {
    // 如果是强制更新，不允许关闭
    if (updateInfo && updateInfo.is_forced) {
      return;
    }
    setShowUpdateModal(false);
  };

  // 页面跳转：可附带下载管理的初始标签
  // 用法：onNavigate('download') 或 onNavigate('download', 'downloading')
  const handleNavigate = (page, tab) => {
    if (page === 'download' && tab) {
      setDownloadInitialTab(tab);
    }
    setCurrentPage(page);
  };

  const handleMinimizeWindow = () => window.electronAPI.minimizeWindow();
  const handleToggleMaximizeWindow = () => window.electronAPI.toggleMaximizeWindow();
  const handleCloseWindow = () => window.electronAPI.closeWindow();
  const refreshLoginStatuses = () => loginStatusPollerRef.current?.run();

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return <HomePage pythonRunning={pythonStatus === 'running'} onNavigate={handleNavigate} />;
      case 'download':
        return <DownloadManager pythonRunning={pythonStatus === 'running'} initialTab={downloadInitialTab} onConsumeTab={() => setDownloadInitialTab(null)} />;
      case 'profile':
        return <ProfileDownload pythonRunning={pythonStatus === 'running'} onNavigate={handleNavigate} />;
      case 'live':
        return <LiveDownload pythonRunning={pythonStatus === 'running'} />;
      case 'comment':
        return <CommentDownload pythonRunning={pythonStatus === 'running'} />;
      case 'hotboard':
        return <HotBoard pythonRunning={pythonStatus === 'running'} />;
      case 'multiplatform':
        return <MultiPlatformDownload onNavigate={handleNavigate} />;
      case 'texttool':
        return <TextTool />;
      case 'xhs-profile':
        return <XhsProfileDownload pythonRunning={pythonStatus === 'running'} onNavigate={handleNavigate} />;
      case 'hongguo':
        return <HongguoDownload onNavigate={handleNavigate} />;
      case 'share':
        return <ShareSoftware updateInfo={updateInfo} />;
      case 'universal':
        return <UniversalDownload onNavigate={handleNavigate} />;
      case 'monitor':
        return <Monitor />;
      case 'operation':
        return <OperationHub onNavigate={setCurrentPage} />;
      case 'account':
        return <AccountManager pythonRunning={pythonStatus === 'running'} />;
      case 'my-accounts':
        return <MyAccounts />;
      case 'my-self':
        return <MySelfDownload />;
      case 'cookie':
        return <CookieManager pythonRunning={pythonStatus === 'running'} />;
      case 'settings':
        return <Settings pythonRunning={pythonStatus === 'running'} />;
      case 'ads':
        return <AdDisplay />;
      default:
        return <HomePage pythonRunning={pythonStatus === 'running'} />;
    }
  };

  return (
    <div className="app">
      <TitleBar
        statuses={loginStatuses}
        isMaximized={windowState.isMaximized}
        isCheckingLoginStatus={isCheckingLoginStatus}
        onCheckLoginStatus={refreshLoginStatuses}
        onMinimize={handleMinimizeWindow}
        onToggleMaximize={handleToggleMaximizeWindow}
        onClose={handleCloseWindow}
      />
      <div className="app-body">
      <Sidebar
        currentPage={currentPage || 'home'}
        onPageChange={setCurrentPage}
        pythonStatus={pythonStatus}
        adsButtonName={adsButtonName}
      />
      <main className="main-content">
        {!configLoaded ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
            <div style={{ textAlign: 'center' }}>
              <div className="loading-spinner" style={{ margin: '0 auto 20px' }}></div>
              <p style={{ color: 'var(--text-tertiary)' }}>正在加载配置...</p>
            </div>
          </div>
        ) : (
          renderPage()
        )}
      </main>
      </div>

      {/* 版本更新弹窗 */}
      {showUpdateModal && updateInfo && (
        <div className="modal-overlay" onClick={closeUpdateModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>发现新版本</h3>
              {!updateInfo.is_forced && (
                <button type="button" className="modal-close" onClick={closeUpdateModal}>×</button>
              )}
            </div>

            <div className="modal-body">
              <div className="update-info">
                <p><strong>当前版本:</strong> {updateInfo.current_version}</p>
                <p><strong>最新版本:</strong> {updateInfo.latest_version}</p>
                <p><strong>发布日期:</strong> {updateInfo.release_date}</p>
                {updateInfo.update_log && (
                  <div className="update-log">
                    <strong>更新日志:</strong>
                    <pre>{updateInfo.update_log}</pre>
                  </div>
                )}
                {updateInfo.is_forced && (
                  <div className="alert alert-danger" style={{ marginTop: '15px' }}>
                    此版本为强制更新，请立即更新后继续使用
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              {!updateInfo.is_forced && (
                <button type="button" className="btn btn-secondary" onClick={closeUpdateModal}>
                  稍后更新
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={handleUpdate}>
                立即更新
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 登录提示弹窗 */}
      {showLoginAlert && (
        <div className="modal-overlay" onClick={() => setShowLoginAlert(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>⚠️ 登录提示</h3>
              <button type="button" className="modal-close" onClick={() => setShowLoginAlert(false)}>×</button>
            </div>

            <div className="modal-body">
              <div className="alert alert-warning">
                <p><strong>您当前未登录抖音账号</strong></p>
                <p>不登录账号功能将受到限制，部分功能可能无法正常使用。</p>
                <p style={{ marginTop: '15px' }}>建议前往"登录平台账号"页面完成登录，以获得完整功能体验。</p>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setShowLoginAlert(false)}>
                稍后登录
              </button>
              <button type="button" className="btn btn-primary" onClick={() => {
                setShowLoginAlert(false);
                setCurrentPage('cookie');
              }}>
                立即登录
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
