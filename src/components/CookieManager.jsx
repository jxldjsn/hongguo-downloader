import React, { useState, useEffect } from 'react';
import './CookieManager.css';

function CookieManager() {
  const [platform, setPlatform] = useState('douyin');
  const [credentialInfo, setCredentialInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [browsers, setBrowsers] = useState([]);
  const [importing, setImporting] = useState(null);
  const [manualCookie, setManualCookie] = useState('');
  const [savingManual, setSavingManual] = useState(false);
  // 导入因浏览器锁文件失败时，记录可重试的 {browserKey, platform}，供「关闭浏览器并重试」使用
  const [retryLocked, setRetryLocked] = useState(null);

  // 诊断工具状态
  const [diagnosticReport, setDiagnosticReport] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [showRawReport, setShowRawReport] = useState(false);

  // 平台文案配置：随平台切换标题/提示词
  const platformConfig = {
    douyin: {
      label: '抖音',
      domain: 'douyin.com',
      pageTitle: '登录抖音账号',
      loginText: '登录抖音账号',
      siteName: '抖音',
    },
    tiktok: {
      label: 'TikTok',
      domain: 'tiktok.com',
      pageTitle: '登录 TikTok 账号',
      loginText: '登录 TikTok 账号',
      siteName: 'TikTok',
    },
    kuaishou: {
      label: '快手',
      domain: 'kuaishou.com',
      pageTitle: '登录快手账号',
      loginText: '登录快手账号',
      siteName: '快手',
    },
    bilibili: {
      label: '哔哩哔哩',
      domain: 'bilibili.com',
      pageTitle: '登录哔哩哔哩账号',
      loginText: '登录哔哩哔哩账号',
      siteName: '哔哩哔哩',
    },
    youtube: {
      label: 'YouTube',
      domain: 'youtube.com',
      pageTitle: '登录 YouTube 账号',
      loginText: '登录 YouTube 账号',
      siteName: 'YouTube',
    },
  };
  const cfg = platformConfig[platform];

  // 切换平台时清空已显示的 Cookie 和提示，避免混淆
  const switchPlatform = (p) => {
    setPlatform(p);
    setCredentialInfo(null);
    setMessage(null);
  };

  useEffect(() => {
    // 检测本机可用浏览器
    window.electronAPI.listBrowsers().then((res) => {
      if (res.success) setBrowsers(res.browsers);
    }).catch(() => {});
  }, []);

  // 执行抖音登录诊断
  const handleRunDiagnostic = async () => {
    setDiagnosing(true);
    setMessage(null);
    try {
      const res = await window.electronAPI.diagnoseDouyinLogin();
      if (res && res.success && res.report) {
        setDiagnosticReport(res.report);
        console.log('[Douyin Diagnostic Report]', res.report);
        setMessage({
          type: res.report.deduction.status === 'healthy' ? 'success' : 'info',
          text: `诊断完成：${res.report.deduction.summary}`,
        });
      } else {
        setMessage({ type: 'error', text: `诊断失败: ${res?.error || '未知错误'}` });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `诊断异常: ${err.message}` });
    } finally {
      setDiagnosing(false);
    }
  };

  // 复制诊断报告
  const handleCopyDiagnosticReport = async () => {
    if (!diagnosticReport || !diagnosticReport.markdownReport) return;
    try {
      await navigator.clipboard.writeText(diagnosticReport.markdownReport);
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2500);
    } catch (err) {
      // 备选降级复制
      const textarea = document.createElement('textarea');
      textarea.value = diagnosticReport.markdownReport;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        setCopiedReport(true);
        setTimeout(() => setCopiedReport(false), 2500);
      } catch (_) {}
      document.body.removeChild(textarea);
    }
  };

  // 从本机浏览器导入 Cookie
  const handleImportFromBrowser = async (browserKey) => {
    setImporting(browserKey);
    setMessage(null);
    setRetryLocked(null);
    try {
      const result = await window.electronAPI.importBrowserCookies(browserKey, platform);
      if (result.success) {
        setMessage({ type: 'success', text: `✓ 已从浏览器导入 ${result.count} 个 Cookie` });
      } else {
        // 文件被锁（浏览器运行中）-> 提供「关闭浏览器并重试」
        if (/锁定|EBUSY|正在运行|busy or locked/i.test(result.error || '')) {
          setRetryLocked({ browserKey, platform });
        }
        setMessage({ type: 'error', text: `✗ 导入失败: ${result.error}` });
      }
    } catch (error) {
      setMessage({ type: 'error', text: `✗ 导入出错: ${error.message}` });
    } finally {
      setImporting(null);
    }
  };

  // 关闭浏览器进程后重新导入（解决 Cookie 文件被 Chrome 独占锁定的问题）
  const handleCloseBrowserAndRetry = async () => {
    if (!retryLocked) return;
    const { browserKey, platform: plat } = retryLocked;
    setRetryLocked(null);
    setImporting(browserKey);
    setMessage({ type: 'info', text: `正在关闭 ${browserKey === 'chrome' ? 'Chrome' : browserKey} 浏览器并重新导入…` });
    try {
      const closeRes = await window.electronAPI.closeBrowser(browserKey);
      if (!closeRes.success) {
        setMessage({ type: 'error', text: `✗ 关闭浏览器失败: ${closeRes.error}` });
        return;
      }
      const result = await window.electronAPI.importBrowserCookies(browserKey, plat);
      if (result.success) {
        setMessage({ type: 'success', text: `✓ 已从浏览器导入 ${result.count} 个 Cookie` });
      } else {
        setMessage({ type: 'error', text: `✗ 导入失败: ${result.error}` });
      }
    } catch (error) {
      setMessage({ type: 'error', text: `✗ 导入出错: ${error.message}` });
    } finally {
      setImporting(null);
    }
  };

  // 打开登录窗口
  const handleLogin = async () => {
    setLoading(true);
    setMessage(null);

    try {
      const result = await window.electronAPI.openLoginWindow(platform);

      if (result.success) {
        setCredentialInfo({ configured: true, count: result.count || 0, entries: [] });
        setMessage({
          type: 'success',
          text: `✓ 登录窗口已关闭并保存 ${result.count || 0} 条登录数据。若顶部仍显示未登录，可点击下方「🩺 诊断抖音登录」查看具体原因。`
        });
      } else {
        setMessage({
          type: 'error',
          text: `✗ 登录失败: ${result.error}`
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `✗ 登录出错: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  // 保存手动粘贴的 Cookie
  const handleSaveManualCookie = async () => {
    if (!manualCookie.trim()) return;
    setSavingManual(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.setCookieManual(manualCookie.trim(), platform);
      if (result.success) {
        setMessage({
          type: 'success',
          text: result.isLoggedIn ? '✓ Cookie 已保存，检测到登录态' : '✓ Cookie 已保存（未检测到登录态，可能影响部分功能）',
        });
        setManualCookie('');
      } else {
        setMessage({ type: 'error', text: `✗ ${result.error}` });
      }
    } catch (error) {
      setMessage({ type: 'error', text: `✗ ${error.message}` });
    } finally {
      setSavingManual(false);
    }
  };

  // 查看当前登录状态（主进程仅返回名称和过期时间，不返回凭据值）
  const handleViewCookies = async () => {
    try {
      const result = await window.electronAPI.getCookies(platform);
      if (!result?.success) throw new Error(result?.error || '读取登录状态失败');
      setCredentialInfo(result);

      setMessage({
        type: 'info',
        text: result.configured
          ? `当前已保存登录状态，会话中有 ${result.count || 0} 条数据`
          : '当前未保存登录状态'
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `获取Cookie失败: ${error.message}`
      });
    }
  };

  // 清除Cookie
  const handleClearCookies = async () => {
    if (!confirm('确定要清除所有Cookie吗？这将需要重新登录。')) {
      return;
    }

    try {
      const result = await window.electronAPI.clearCookies(platform);
      if (!result?.success) throw new Error(result?.error || '清除失败');
      setCredentialInfo(null);
      setDiagnosticReport(null);
      setMessage({
        type: 'success',
        text: '✓ 登录数据已彻底清除'
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `清除失败: ${error.message}`
      });
    }
  };

  return (
    <div className="cookie-manager fade-in">
      <h1 className="page-title">{cfg.pageTitle}</h1>

      {/* 平台切换 Tab */}
      <div className="platform-tabs">
        {Object.entries(platformConfig).map(([key, c]) => (
          <button
            key={key}
            className={`platform-tab${platform === key ? ' active' : ''}`}
            onClick={() => switchPlatform(key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
          {retryLocked && (
            <button
              className="retry-locked-btn"
              onClick={handleCloseBrowserAndRetry}
              disabled={importing === retryLocked.browserKey}
              style={{ marginLeft: 12 }}
            >
              {importing === retryLocked.browserKey ? '处理中…' : '关闭浏览器并重试'}
            </button>
          )}
        </div>
      )}

      {/* 从本机浏览器导入 */}
      <div className="card">
        <h3>🌐 从本机浏览器导入 Cookie</h3>
        <p className="import-tip">
          如果你已在 Chrome / Edge 等浏览器登录{cfg.siteName}，可直接一键导入，无需重新登录。
        </p>
        {browsers.length === 0 ? (
          <div className="alert alert-info">未检测到支持的浏览器（Chrome / Edge / Brave）</div>
        ) : (
          <div className="actions">
            {browsers.map((b) => (
              <button
                key={b.key}
                className="btn btn-primary"
                onClick={() => handleImportFromBrowser(b.key)}
                disabled={importing !== null}
              >
                {importing === b.key ? (
                  <>
                    <span className="loading-spinner"></span>
                    导入中...
                  </>
                ) : (
                  <>
                    <span>🌐</span>
                    从 {b.name} 导入
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="alert alert-info" style={{ marginTop: '12px' }}>
          <strong>提示:</strong> 导入前请先<strong>完全关闭对应浏览器</strong>，否则数据库被占用可能导入失败。导入仅读取 {cfg.domain} 的 Cookie。
        </div>
      </div>

      {/* 手动粘贴 Cookie */}
      <div className="card">
        <h3>📋 手动粘贴 Cookie</h3>
        <p className="import-tip">
          从浏览器开发者工具或扩展复制 {cfg.domain} 的 Cookie 字符串粘贴到这里。新版 Chrome 无法自动读取时，这是最可靠的方式。
        </p>
        <textarea
          className="form-input cookie-textarea"
          placeholder="name1=value1; name2=value2; ..."
          value={manualCookie}
          onChange={(e) => setManualCookie(e.target.value)}
          rows={4}
        />
        <div className="actions" style={{ marginTop: '10px' }}>
          <button
            className="btn btn-primary"
            onClick={handleSaveManualCookie}
            disabled={savingManual || !manualCookie.trim()}
          >
            {savingManual ? '保存中...' : '💾 保存 Cookie'}
          </button>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="card">
        <h3>Cookie 操作</h3>
        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="loading-spinner"></span>
                登录中...
              </>
            ) : (
              <>
                <span>🔐</span>
                打开登录窗口
              </>
            )}
          </button>

          <button
            className="btn btn-secondary"
            onClick={handleViewCookies}
          >
            <span>👁️</span>
            查看登录状态
          </button>

          {platform === 'douyin' && (
            <button
              className="btn btn-warning diagnostic-btn"
              onClick={handleRunDiagnostic}
              disabled={diagnosing}
              title="运行全链路诊断，检测 Cookie、本地规则与远端接口响应"
            >
              {diagnosing ? (
                <>
                  <span className="loading-spinner"></span>
                  正在诊断...
                </>
              ) : (
                <>
                  <span>🩺</span>
                  诊断抖音登录
                </>
              )}
            </button>
          )}

          <button
            className="btn btn-danger"
            onClick={handleClearCookies}
          >
            <span>🗑️</span>
            清除Cookie
          </button>
        </div>
      </div>

      {/* 抖音登录全链路诊断报告卡片 */}
      {diagnosticReport && platform === 'douyin' && (
        <div className="card diagnostic-card">
          <div className="diagnostic-header">
            <div className="diagnostic-title-area">
              <h3>🩺 抖音登录全链路诊断结果</h3>
              <span className={`diagnostic-badge status-${diagnosticReport.deduction.status}`}>
                {diagnosticReport.deduction.status === 'healthy' ? '✓ 登录有效' :
                 diagnosticReport.deduction.status === 'no-cookie' ? '× 无 Cookie' :
                 diagnosticReport.deduction.status === 'missing-sessionid' ? '! 缺少 sessionid_ss' :
                 diagnosticReport.deduction.status === 'cookie-expired' ? '! 服务端已失效 (status 8)' :
                 diagnosticReport.deduction.status === 'risk-control' ? '! 命中风控滑块' :
                 diagnosticReport.deduction.status}
              </span>
            </div>
            <div className="diagnostic-header-actions">
              <button
                className={`btn ${copiedReport ? 'btn-success' : 'btn-primary'} btn-sm`}
                onClick={handleCopyDiagnosticReport}
              >
                {copiedReport ? '✓ 已复制报告内容' : '📋 复制完整诊断报告'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRunDiagnostic}
                disabled={diagnosing}
              >
                ↻ 重新诊断
              </button>
            </div>
          </div>

          <div className="diagnostic-summary-box">
            <p className="summary-title">💡 诊断结论：</p>
            <p className="summary-text">{diagnosticReport.deduction.summary}</p>
            {diagnosticReport.deduction.suggestedActions && diagnosticReport.deduction.suggestedActions.length > 0 && (
              <div className="suggested-actions">
                <span className="actions-title">建议操作：</span>
                <ol>
                  {diagnosticReport.deduction.suggestedActions.map((act, i) => (
                    <li key={i}>{act}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          <div className="diagnostic-grid">
            {/* 1. 本地存储 */}
            <div className="diag-section">
              <h4>1. 本地数据库凭据 (cookie_douyin)</h4>
              <div className="diag-item">
                <span className="diag-label">已保存凭据:</span>
                <span className={`diag-value ${diagnosticReport.dbStorage.hasStoredCookie ? 'text-ok' : 'text-fail'}`}>
                  {diagnosticReport.dbStorage.hasStoredCookie ? `✓ 存在 (${diagnosticReport.dbStorage.cookieLength} 字符)` : '✗ 不存在'}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Cookie 条目数:</span>
                <span className="diag-value">{diagnosticReport.dbStorage.totalCookies || 0} 个</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">核心认证键 (sessionid_ss 等):</span>
                <span className={`diag-value ${diagnosticReport.dbStorage.hasAuthKeys ? 'text-ok' : 'text-fail'}`}>
                  {diagnosticReport.dbStorage.hasAuthKeys ? '✓ 包含认证凭据' : '✗ 缺失 sessionid 等'}
                </span>
              </div>
              {diagnosticReport.dbStorage.keyDetails && (
                <div className="diag-key-tags">
                  {Object.entries(diagnosticReport.dbStorage.keyDetails).map(([k, v]) => (
                    <span key={k} className={`key-tag ${v.present ? 'tag-ok' : 'tag-missing'}`}>
                      {k}: {v.present ? (v.preview || '存在') : '缺失'}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 2. 远端接口探针 */}
            <div className="diag-section">
              <h4>2. 远端接口实测探测</h4>
              {diagnosticReport.remoteProbes.probes && diagnosticReport.remoteProbes.probes.length > 0 ? (
                diagnosticReport.remoteProbes.probes.map((p, i) => (
                  <div key={i} className="probe-item">
                    <div className="probe-head">
                      <span className="probe-name">{p.name}</span>
                      <span className={`probe-result-badge probe-${p.result}`}>
                        {p.result === 'logged-in' ? '✓ 正常' :
                         p.result === 'logged-out' ? '✗ 未登录/失效' :
                         p.result === 'risk-blocked' ? '⚠️ 风控拦截' :
                         p.result}
                      </span>
                    </div>
                    <div className="probe-detail-line">
                      <span>HTTP {p.httpStatus || 'ERR'} · {p.elapsedMs || 0}ms · {p.detailNote}</span>
                    </div>
                    {p.userInfo && (
                      <div className="probe-user-pill">
                        👤 识别账号：<strong>{p.userInfo.nickname}</strong> (UID: {p.userInfo.uid})
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="diag-empty">{diagnosticReport.remoteProbes.summary || '未执行探针测试'}</div>
              )}
            </div>
          </div>

          <div className="diagnostic-footer">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowRawReport(!showRawReport)}
            >
              {showRawReport ? '▲ 收起详细原始数据' : '▼ 查看详细原始数据 / Markdown'}
            </button>

            {showRawReport && (
              <div className="raw-report-box">
                <textarea
                  className="form-input raw-report-textarea"
                  value={diagnosticReport.markdownReport}
                  readOnly
                  rows={12}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 只显示非敏感的登录状态元数据 */}
      {credentialInfo && (
        <div className="card">
          <h3>登录状态</h3>
          <div className="cookie-info">
            <div className="info-item">
              <span className="info-label">安全存储:</span>
              <span className="info-value">{credentialInfo.configured ? '已配置' : '未配置'}</span>
            </div>
            <div className="info-item">
              <span className="info-label">当前会话条目:</span>
              <span className="info-value">{credentialInfo.count || 0}</span>
            </div>

            {credentialInfo.entries && credentialInfo.entries.length > 0 && (
              <div className="cookie-table-section">
                <h4>会话条目（凭据值已隐藏）</h4>
                <div className="cookie-table-wrapper">
                  <table className="cookie-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>域</th>
                        <th>过期时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credentialInfo.entries.map((entry, idx) => (
                        <tr key={idx}>
                          <td className="cookie-name">{entry.name}</td>
                          <td>{entry.domain}</td>
                          <td>
                            {entry.expirationDate
                              ? new Date(entry.expirationDate * 1000).toLocaleString('zh-CN')
                              : '会话'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 使用说明 */}
      <div className="card">
        <h3>💡 使用说明</h3>
        <ol className="instructions-list">
          <li>点击<strong>"打开登录窗口"</strong>按钮</li>
          <li>在弹出的浏览器窗口中登录{cfg.siteName}账号</li>
          <li>登录成功后，点击右上角的<strong>"确认登录并返回"</strong>按钮</li>
          <li>登录数据会使用 Windows 当前用户凭据加密保存</li>
          <li>如果扫码后页面仍显示未登录，点击<strong>"🩺 诊断抖音登录"</strong>按钮一键排查具体原因，并可一键复制诊断信息</li>
        </ol>

        <div className="alert alert-info">
          <strong>提示:</strong> Cookie会影响视频下载的分辨率，建议使用已登录的Cookie以获取最高画质。
        </div>
      </div>
    </div>
  );
}

export default CookieManager;
