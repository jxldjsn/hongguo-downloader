import React, { useState, useEffect, useRef } from 'react';
import api from '../utils/api';
import { THEMES, getTheme, setTheme } from '../utils/theme';
import './Settings.css';

// 文件命名变量标签：显示中文，保存/渲染时对应英文变量
const NAME_TAGS = [
  { zh: '下载时间', en: 'download_time' },
  { zh: '类型', en: 'type' },
  { zh: '作者', en: 'nickname' },
  { zh: '标题', en: 'desc' },
  { zh: '作品ID', en: 'id' },
];

function Settings() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [theme, setThemeState] = useState(getTheme());
  // 文件命名输入框：记录光标位置，点击标签在光标处插入
  const nameInputRef = useRef(null);
  const nameSelStart = useRef(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      setSettings(data);
    } catch (error) {
      setMessage({
        type: 'error',
        text: `加载设置失败: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  // 切换主题（即时生效 + 持久化）
  const handleThemeChange = async (code) => {
    if (code === theme) return;
    setThemeState(code);
    await setTheme(code);
    setMessage({ type: 'success', text: `✓ 已切换至「${THEMES.find(t => t.code === code)?.name}」主题` });
    // 3 秒后自动清除提示
    setTimeout(() => setMessage(prev => (prev && prev.text && prev.text.includes('主题') ? null : prev)), 3000);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const parseInteger = (key, label, min, max) => {
        const value = Number(settings?.[key]);
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
          throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
        }
        return value;
      };
      const normalized = {
        ...settings,
        concurrency: parseInteger('concurrency', '同时下载数', 1, 10),
        timeout: parseInteger('timeout', '请求超时', 1, 300),
        max_retry: parseInteger('max_retry', '最大重试次数', 0, 20),
      };
      const result = await api.updateSettings(normalized);
      if (!result?.success) throw new Error(result?.error || '主进程未保存设置');
      setSettings(normalized);

      setMessage({
        type: 'success',
        text: '✓ 设置已保存'
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `保存失败: ${error.message}`
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSelectFolder = async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
      setSettings({ ...settings, root: folder });
    }
  };

  if (loading) {
    return (
      <div className="settings-page">
        <h1 className="page-title">设置</h1>
        <div className="card">
          <div className="loading-spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page fade-in">
      <h1 className="page-title">设置</h1>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      {/* 主题切换 */}
      <div className="card">
        <h2>🎨 主题外观</h2>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.code}
              type="button"
              className={`theme-card${theme === t.code ? ' active' : ''}`}
              onClick={() => handleThemeChange(t.code)}
            >
              <div className="theme-swatch">
                {t.swatch.map((c, i) => (
                  <span key={i} className="theme-swatch-dot" style={{ background: c }} />
                ))}
              </div>
              <div className="theme-card-info">
                <div className="theme-card-name">{t.name}</div>
                <div className="theme-card-desc">{t.desc}</div>
              </div>
              {theme === t.code && <span className="theme-check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      {/* 下载设置 */}
      <div className="card">
        <h2>📥 下载设置</h2>

        <div className="form-group">
          <label className="form-label">下载目录</label>
          <div className="input-with-button">
            <input
              type="text"
              className="form-input"
              value={settings?.root || ''}
              onChange={(e) => setSettings({ ...settings, root: e.target.value })}
              placeholder="选择下载目录..."
            />
            <button
              className="btn btn-secondary"
              onClick={handleSelectFolder}
            >
              📁 浏览
            </button>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">文件夹名称</label>
          <input
            type="text"
            className="form-input"
            value={settings?.folder_name || ''}
            onChange={(e) => setSettings({ ...settings, folder_name: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">文件命名格式</label>
          <input
            ref={nameInputRef}
            type="text"
            className="form-input"
            value={settings?.name_format || ''}
            onChange={(e) => setSettings({ ...settings, name_format: e.target.value })}
            onSelect={(e) => { nameSelStart.current = e.target.selectionStart; }}
            onBlur={(e) => { nameSelStart.current = e.target.selectionStart; }}
            placeholder="如: 下载时间 类型 作者 标题"
          />
          <div className="name-tag-row">
            {NAME_TAGS.map((t) => (
              <button
                key={t.en}
                type="button"
                className="name-tag"
                title={`点击插入「${t.zh}」到光标位置`}
                onClick={() => {
                  const el = nameInputRef.current;
                  const cur = String(settings?.name_format || '');
                  const pos = (el && nameSelStart.current != null)
                    ? nameSelStart.current
                    : (el ? el.selectionStart || cur.length : cur.length);
                  // 在光标位置插入标签（带空格分隔），光标定位到插入内容之后
                  const prefix = cur.slice(0, pos).trimEnd();
                  const suffix = cur.slice(pos);
                  const ins = prefix ? ` ${t.zh}` : t.zh;
                  const next = `${prefix}${ins}${suffix ? ` ${suffix.trimStart()}` : ''}`;
                  setSettings({ ...settings, name_format: next });
                  setTimeout(() => {
                    if (el) {
                      const newPos = prefix.length + ins.length + (suffix ? 1 : 0);
                      el.focus();
                      el.setSelectionRange(newPos, newPos);
                      nameSelStart.current = newPos;
                    }
                  }, 0);
                }}
              >
                {t.zh}
              </button>
            ))}
          </div>
          <small className="form-help">输入框里的即是当前命名格式（默认「标题 作品ID」），点击上方标签在光标处插入，或直接修改；变量未填写的部分自动省略</small>
        </div>

        <div className="checkbox-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings?.folder_mode || false}
              onChange={(e) => setSettings({ ...settings, folder_mode: e.target.checked })}
            />
            <span>按账号创建文件夹</span>
          </label>

        </div>

        <div className="form-group">
          <label className="form-label">同时下载数</label>
          <input
            type="number"
            className="form-input"
            value={settings?.concurrency ?? ''}
            onChange={(e) => setSettings({ ...settings, concurrency: e.target.value })}
            min="1"
            max="10"
          />
          <small className="form-help">建议 3–5 个；过高可能触发网站限速。</small>
        </div>
      </div>

      {/* 网络设置 */}
      <div className="card">
        <h2>🌐 网络设置</h2>

        <div className="form-group">
          <label className="form-label">代理地址</label>
          <input
            type="text"
            className="form-input"
            value={settings?.proxy || ''}
            onChange={(e) => setSettings({ ...settings, proxy: e.target.value })}
            placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">请求超时 (秒)</label>
            <input
              type="number"
              className="form-input"
              value={settings?.timeout ?? ''}
              onChange={(e) => setSettings({ ...settings, timeout: e.target.value })}
              min="1"
              max="300"
            />
          </div>

          <div className="form-group">
            <label className="form-label">最大重试次数</label>
            <input
              type="number"
              className="form-input"
              value={settings?.max_retry ?? ''}
              onChange={(e) => setSettings({ ...settings, max_retry: e.target.value })}
              min="0"
              max="20"
            />
          </div>
        </div>
      </div>

      {/* 保存按钮 */}
      <div className="actions-bar">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <>
              <span className="loading-spinner"></span>
              保存中...
            </>
          ) : (
            <>
              <span>💾</span>
              保存设置
            </>
          )}
        </button>

        <button
          className="btn btn-secondary"
          onClick={loadSettings}
        >
          <span>↻</span>
          重置
        </button>
      </div>
    </div>
  );
}

export default Settings;
