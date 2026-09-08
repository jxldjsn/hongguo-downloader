import React, { useState, useEffect, useMemo } from 'react';
import api from '../utils/api';
import { exportVideosToXlsx } from '../utils/xlsxExport';
import './AccountManager.css';
import TrendChart from './TrendChart';
import HotVideoAnalysisModal from './HotVideoAnalysisModal';
import {
  Database, Plus, Link2, AlertCircle, User, Film, ChevronDown, TrendingUp, Clock,
  X, Activity, Heart, ExternalLink, Layers, Edit3, FolderPlus, Trash2, Check, Flame,
  Pin, Tag, Copy,
} from './icons';

const PRESET_TAGS = ['颜值', '美妆', '搞笑', '科技', '数码', '游戏', '美食', '穿搭', '知识', '高粉', '电商', '日常'];

function formatNumber(num) {
  if (typeof num !== 'number') return '0';
  if (num >= 100000000) return (num / 100000000).toFixed(2) + '亿';
  if (num >= 10000) return (num / 10000).toFixed(2) + '万';
  return String(num);
}

function formatCount(n) {
  if (typeof n !== 'number') return '0';
  if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + 'w';
  // 小数值四舍五入到整数，避免显示 -7890.001817833961 这种长尾浮点
  return String(Math.round(n));
}

// 计算历史序列的上升速度（最近窗口的斜率，单位：增量/小时）
function growthRate(history, valueKey, windowHours = 24) {
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
function totalDelta(history, valueKey) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  return history[history.length - 1][valueKey] - history[0][valueKey];
}

function AccountManager({ pythonRunning = false }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [accounts, setAccounts] = useState([]);

  // 作品下钻弹窗
  const [worksModalAccount, setWorksModalAccount] = useState(null); // 当前打开作品弹窗的账号
  const [copyFeedback, setCopyFeedback] = useState(null); // 批量复制链接后的提示文案（null=不显示）
  const [accountWorks, setAccountWorks] = useState({}); // { sec_user_id: { list, loading, error, cursor, hasMore } }
  const [worksSort, setWorksSort] = useState('newest'); // newest | digg | comment

  // 增速弹窗
  const [modalAccount, setModalAccount] = useState(null); // 当前弹窗账号

  // 分组相关
  const [groups, setGroups] = useState([]);                       // 分组列表
  const [activeGroupId, setActiveGroupId] = useState('all');      // 当前筛选: 'all' | 'ungrouped' | groupId
  const [showGroupMgr, setShowGroupMgr] = useState(false);        // 分组管理弹窗
  const [newGroupName, setNewGroupName] = useState('');           // 新建分组输入
  const [editingGroupId, setEditingGroupId] = useState(null);     // 正在重命名的分组 id
  const [editingGroupName, setEditingGroupName] = useState('');   // 重命名输入值
  const [selectedGroupId, setSelectedGroupId] = useState('');     // 添加账号时选的目标分组
  const [analysisGroup, setAnalysisGroup] = useState(null);       // 爆款分析弹窗: null=关闭, {name, accounts}

  // 标签筛选与编辑
  const [activeTag, setActiveTag] = useState('');                 // 当前筛选标签: ''=全部
  const [editingTagAccount, setEditingTagAccount] = useState(null); // 当前编辑标签的账号
  // 常用标签池（localStorage 持久化，无则用默认预设）
  const [customPresetTags, setCustomPresetTags] = useState(() => {
    try {
      const raw = localStorage.getItem('douyin_custom_preset_tags');
      const list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list) && list.length > 0 ? list : PRESET_TAGS;
    } catch (e) {
      return PRESET_TAGS;
    }
  });
  const [selectedAccountTags, setSelectedAccountTags] = useState([]); // 当前编辑账号已勾选的标签
  const [newPresetInput, setNewPresetInput] = useState('');           // 新建常用标签输入框

  // 批量添加相关
  const [batchMode, setBatchMode] = useState(false);              // 单条/批量 切换
  const [batchText, setBatchText] = useState('');                 // 批量输入文本
  const [batchResults, setBatchResults] = useState(null);         // 批量结果 { results, summary }
  const [batchLoading, setBatchLoading] = useState(false);

  // 从数据库加载账号（首次启动时把旧 localStorage 数据迁移进 DB）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 一次性迁移旧 localStorage 数据到 DB
        const legacy = localStorage.getItem('saved_accounts');
        if (legacy) {
          try {
            const legacyAccounts = JSON.parse(legacy);
            if (Array.isArray(legacyAccounts) && legacyAccounts.length > 0) {
              const sourceIds = [...new Set(legacyAccounts
                .map((account) => String(account?.sec_user_id || '').trim())
                .filter(Boolean))];
              const allSourcesIdentified = legacyAccounts.every(
                (account) => String(account?.sec_user_id || '').trim().length > 0,
              );
              const migrationResult = await window.electronAPI.accountMigrateLocalStorage(legacyAccounts);
              const migratedIds = new Set((migrationResult?.migratedIds || []).map(String));
              const migrationComplete = migrationResult?.success === true
                && allSourcesIdentified
                && Number(migrationResult.migrated) >= legacyAccounts.length
                && sourceIds.every((id) => migratedIds.has(id));
              if (migrationComplete) {
                localStorage.removeItem('saved_accounts');
                console.log('[Account] 已把 localStorage 账号迁移到数据库');
              } else if (!cancelled) {
                setError(migrationResult?.error || '旧账号数据未完整迁移，备份已保留，请重新打开页面重试');
              }
            } else {
              localStorage.removeItem('saved_accounts');
            }
          } catch (err) {
            console.warn('[Account] 旧数据迁移失败:', err);
            if (!cancelled) setError(`旧账号数据迁移失败，备份已保留：${err.message || '未知错误'}`);
          }
        }

        const res = await window.electronAPI.accountList();
        if (!cancelled) {
          if (res && res.success) {
            setAccounts(res.accounts || []);
          } else {
            setError(res?.error || '加载账号失败');
          }
        }

        // 加载分组列表
        const gRes = await window.electronAPI.groupList();
        if (!cancelled && gRes && gRes.success) {
          setGroups(gRes.groups || []);
        }
      } catch (err) {
        console.error('加载账号失败:', err);
        if (!cancelled) setError(err.message || '加载账号失败');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 监听主进程账号更新推送（监控周期抓取后会刷新）
  useEffect(() => {
    const unsubscribeAccountUpdated = window.electronAPI.onAccountUpdated((data) => {
      if (data && Array.isArray(data.accounts)) {
        setAccounts(data.accounts);
      }
    });
    return () => {
      unsubscribeAccountUpdated();
    };
  }, []);

  // 添加账号
  const handleAddAccount = async () => {
    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }

    if (!url.trim()) {
      setError('请输入有效的用户主页链接或ID');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. 解析链接获取 sec_user_id
      let secUserId = null;

      if (url.includes('douyin.com') || url.includes('v.douyin.com')) {
        const directMatch = url.match(/user\/([^?&/]+)/);
        if (directMatch) {
          secUserId = directMatch[1];
        } else {
          try {
            const resolved = await api.resolveShareLink(url);
            if (resolved && typeof resolved === 'string') {
              const match = resolved.match(/user\/([^?&/]+)/);
              if (match) {
                secUserId = match[1];
              }
            }
          } catch (err) {
            console.warn('链接解析失败:', err);
          }
        }
      } else {
        secUserId = url.trim();
      }

      if (!secUserId) {
        throw new Error('无法从链接中提取用户ID，请检查链接格式');
      }

      // 检查是否已存在
      if (accounts.some(acc => acc.sec_user_id === secUserId)) {
        throw new Error('该账号已存在');
      }

      // 2. 获取用户信息
      const profileData = await api.getUserProfile(secUserId);
      console.log('用户信息:', profileData);

      if (!profileData || !profileData.user) {
        throw new Error('获取用户信息失败，请检查链接是否正确或登录状态');
      }

      const user = profileData.user;
      const accountData = {
        sec_user_id: secUserId,
        nickname: user.nickname || '未知用户',
        unique_id: user.unique_id || user.short_id || '',
        avatar: user.avatar_thumb?.url_list?.[0] || '',
        signature: user.signature || '',
        follower_count: user.follower_count || 0,
        following_count: user.following_count || 0,
        total_favorited: user.total_favorited || 0,
        aweme_count: user.aweme_count || 0,
        favoriting_count: user.favoriting_count || 0,
        added_time: Date.now(),
        group_id: selectedGroupId || null,
      };

      // 添加到列表（持久化到数据库）
      const res = await window.electronAPI.accountAdd(accountData);
      if (res && res.success) {
        setAccounts(res.accounts || []);
      } else {
        throw new Error(res?.error || '保存账号失败');
      }

      setUrl('');
      console.log('账号添加成功:', accountData.nickname);

    } catch (err) {
      console.error('添加账号失败:', err);
      setError(err.message || '添加账号失败');
    } finally {
      setLoading(false);
    }
  };

  // 提取全量独立标签及其对应的账号数量
  const allTagsMap = useMemo(() => {
    const map = {};
    accounts.forEach(a => {
      if (a.tags) {
        const list = String(a.tags).split(',').map(t => t.trim()).filter(Boolean);
        list.forEach(t => {
          map[t] = (map[t] || 0) + 1;
        });
      }
    });
    return map;
  }, [accounts]);

  const allTags = useMemo(() => Object.keys(allTagsMap), [allTagsMap]);

  // 按当前选中分组与标签筛选账号
  const filteredAccounts = useMemo(() => {
    return accounts.filter(a => {
      let matchGroup = true;
      if (activeGroupId === 'all') matchGroup = true;
      else if (activeGroupId === 'ungrouped') matchGroup = !a.group_id;
      else matchGroup = a.group_id === activeGroupId;

      let matchTag = true;
      if (activeTag) {
        const accTags = (a.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        matchTag = accTags.includes(activeTag);
      }

      return matchGroup && matchTag;
    });
  }, [accounts, activeGroupId, activeTag]);

  // 切换置顶
  const handleTogglePin = async (account) => {
    if (!account) return;
    const newPinned = account.pinned ? 0 : 1;
    try {
      const res = await window.electronAPI?.accountUpdateMeta?.(account.sec_user_id, { pinned: newPinned });
      if (res && res.success) {
        setAccounts(res.accounts || []);
      } else if (res?.error) {
        alert(res.error);
      }
    } catch (err) {
      console.error('置顶更新失败:', err);
    }
  };

  // 保存常用标签池到 localStorage
  const saveCustomPresetTags = (newList) => {
    const list = Array.isArray(newList) ? newList : [];
    const unique = Array.from(new Set(list.map(t => String(t || '').trim()).filter(Boolean)));
    setCustomPresetTags(unique);
    try {
      localStorage.setItem('douyin_custom_preset_tags', JSON.stringify(unique));
    } catch (e) {}
  };

  // 打开标签编辑
  const handleOpenTagEditor = (account) => {
    try {
      setEditingTagAccount(account);
      const existing = (account && account.tags) ? String(account.tags).split(',').map(t => t.trim()).filter(Boolean) : [];
      const currentPool = Array.isArray(customPresetTags) ? customPresetTags : ['颜值', '美妆', '搞笑', '科技', '数码', '游戏', '美食', '穿搭', '剧情', '高粉', '男博主', '女博主'];
      const mergedPool = Array.from(new Set([...currentPool, ...existing]));
      if (mergedPool.length !== currentPool.length) {
        saveCustomPresetTags(mergedPool);
      }
      setSelectedAccountTags(existing);
      setNewPresetInput('');
    } catch (err) {
      console.error('[Account] 打开标签编辑失败:', err);
    }
  };

  // 切换账号勾选标签状态
  const handleToggleTagSelection = (tag) => {
    setSelectedAccountTags(prev => {
      const arr = Array.isArray(prev) ? prev : [];
      return arr.includes(tag) ? arr.filter(t => t !== tag) : [...arr, tag];
    });
  };

  // 创建新的常用标签并自动为当前账号勾选
  const handleCreateNewPresetTag = () => {
    const tag = (newPresetInput || '').replace(/[,，\s]+/g, '').trim();
    if (!tag) return;
    const pool = Array.isArray(customPresetTags) ? customPresetTags : [];
    if (!pool.includes(tag)) {
      saveCustomPresetTags([...pool, tag]);
    }
    setSelectedAccountTags(prev => {
      const arr = Array.isArray(prev) ? prev : [];
      return arr.includes(tag) ? arr : [...arr, tag];
    });
    setNewPresetInput('');
  };

  // 从常用标签池中删除某个标签
  const handleDeletePresetTag = (tagToDelete, e) => {
    if (e) e.stopPropagation();
    const updated = customPresetTags.filter(t => t !== tagToDelete);
    saveCustomPresetTags(updated);
    setSelectedAccountTags(prev => prev.filter(t => t !== tagToDelete));
  };

  // 保存标签绑定结果
  const handleSaveTags = async () => {
    if (!editingTagAccount) return;
    try {
      const uniqueTagsStr = selectedAccountTags.join(',');

      const res = await window.electronAPI.accountUpdateMeta(editingTagAccount.sec_user_id, { tags: uniqueTagsStr });
      if (res && res.success) {
        setAccounts(res.accounts || []);
      } else {
        alert(res?.error || '标签更新失败');
      }
    } catch (err) {
      console.error('更新标签失败:', err);
      alert(err.message || '更新标签失败');
    }
    setEditingTagAccount(null);
  };

  // 分组名映射：groupId -> name（用于账号卡片显示分组标签）
  const groupNameMap = useMemo(() => {
    const m = {};
    groups.forEach(g => { m[g.id] = g.name; });
    return m;
  }, [groups]);

  // 新建分组
  const handleAddGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const res = await window.electronAPI.groupAdd(name);
      if (res && res.success) {
        setGroups(res.groups || []);
        setNewGroupName('');
      } else {
        alert(res?.error || '新建分组失败');
      }
    } catch (err) {
      alert(err.message || '新建分组失败');
    }
  };

  // 重命名分组
  const handleRenameGroup = async (id) => {
    const name = editingGroupName.trim();
    if (!name) { setEditingGroupId(null); return; }
    try {
      const res = await window.electronAPI.groupRename(id, name);
      if (res && res.success) {
        setGroups(res.groups || []);
      } else {
        alert(res?.error || '重命名失败');
      }
    } catch (err) {
      alert(err.message || '重命名失败');
    }
    setEditingGroupId(null);
  };

  // 删除分组
  const handleRemoveGroup = async (id, name) => {
    if (!confirm(`确定删除分组「${name}」吗？该组下的账号会归到"未分组"。`)) return;
    try {
      const res = await window.electronAPI.groupRemove(id);
      if (res && res.success) {
        setGroups(res.groups || []);
        if (res.accounts) setAccounts(res.accounts);
        // 若当前筛选的是被删的分组，回到全部
        if (activeGroupId === id) setActiveGroupId('all');
      } else {
        alert(res?.error || '删除分组失败');
      }
    } catch (err) {
      alert(err.message || '删除分组失败');
    }
  };

  // 把账号移到指定分组
  const handleMoveAccount = async (secUserId, groupId) => {
    try {
      const res = await window.electronAPI.groupMoveAccount(secUserId, groupId || null);
      if (res && res.success) {
        setAccounts(res.accounts || []);
      }
    } catch (err) {
      console.error('移动账号失败:', err);
    }
  };

  // 批量添加账号
  const handleBatchAdd = async () => {
    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }
    const items = batchText.split('\n').map(s => s.trim()).filter(Boolean);
    if (items.length === 0) {
      setError('请输入至少一个链接或ID');
      return;
    }

    setBatchLoading(true);
    setError(null);
    setBatchResults(null);

    try {
      const res = await window.electronAPI.accountAddBatch(items, selectedGroupId || null);
      if (res && res.success) {
        setAccounts(res.accounts || []);
        setBatchResults({ results: res.results || [], summary: res.summary || {} });
        setBatchText('');
        console.log('[Account] 批量添加完成:', res.summary);
      } else {
        setError(res?.error || '批量添加失败');
      }
    } catch (err) {
      console.error('批量添加失败:', err);
      setError(err.message || '批量添加失败');
    } finally {
      setBatchLoading(false);
    }
  };

  // 删除账号
  const handleDeleteAccount = async (secUserId) => {
    if (!confirm('确定要删除该账号吗？')) {
      return;
    }

    try {
      const res = await window.electronAPI.accountRemove(secUserId);
      if (res && res.success) {
        setAccounts(res.accounts || []);
      } else {
        setError(res?.error || '删除失败');
      }
    } catch (err) {
      console.error('删除失败:', err);
      setError(err.message || '删除失败');
    }
  };

  // 刷新账号信息
  const handleRefreshAccount = async (secUserId) => {
    setLoading(true);
    setError(null);

    try {
      const profileData = await api.getUserProfile(secUserId);
      if (!profileData || !profileData.user) {
        throw new Error('刷新失败');
      }

      const user = profileData.user;
      const patch = {
        nickname: user.nickname || '',
        unique_id: user.unique_id || user.short_id || '',
        avatar: user.avatar_thumb?.url_list?.[0] || '',
        signature: user.signature || '',
        follower_count: user.follower_count || 0,
        following_count: user.following_count || 0,
        total_favorited: user.total_favorited || 0,
        aweme_count: user.aweme_count || 0,
        favoriting_count: user.favoriting_count || 0,
      };

      const res = await window.electronAPI.accountRefresh(secUserId, patch);
      if (res && res.success) {
        setAccounts(res.accounts || []);
      } else {
        throw new Error(res?.error || '刷新失败');
      }
      console.log('账号信息已刷新');

    } catch (err) {
      console.error('刷新失败:', err);
      setError(err.message || '刷新失败');
    } finally {
      setLoading(false);
    }
  };

  // 导出账号作品列表为 Excel（与主页下载导出一致：类型/发布时间/文案/合集/点赞/评论/收藏/分享/时长/链接）
  const handleExportAccount = async (account) => {
    try {
      // 优先用已加载的作品列表；没有则实时抓取前 20 条
      let works = accountWorks[account.sec_user_id]?.list;
      if (!works || works.length === 0) {
        const result = await window.electronAPI.nativeAPI('douyin', 'getUserVideos', {
          secUserId: account.sec_user_id,
          cursor: 0,
          count: 20,
        });
        works = result?.aweme_list || result?.data?.aweme_list || [];
      }
      if (!works || works.length === 0) {
        setError('该账号暂无作品可导出');
        return;
      }
      await exportVideosToXlsx(works, account.nickname);
      console.log('作品 Excel 已导出:', account.nickname, works.length, '条');
    } catch (err) {
      console.error('导出失败:', err);
      setError(err.message || '导出失败');
    }
  };

  // 打开作品弹窗（每次打开都重新拉取，保证数据新鲜）
  const openWorks = async (account) => {
    setCopyFeedback(null);
    setWorksModalAccount(account);
    await fetchWorks(account, 0);
  };

  // 拉取账号作品（nativeAPI -> douyin getUserVideos）
  const fetchWorks = async (account, cursor = 0) => {
    const id = account.sec_user_id;
    setAccountWorks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), loading: true, error: null },
    }));
    try {
      const result = await window.electronAPI.nativeAPI('douyin', 'getUserVideos', {
        secUserId: id,
        cursor,
        count: 20,
      });
      const list = result?.aweme_list || result?.data?.aweme_list || [];
      const nextCursor = result?.max_cursor || result?.data?.max_cursor || 0;
      const prev = accountWorks[id];
      const merged = cursor === 0 ? list : [...(prev?.list || []), ...list];
      setAccountWorks((p) => ({
        ...p,
        [id]: {
          list: merged,
          loading: false,
          cursor: nextCursor,
          hasMore: list.length >= 15,
          error: null,
        },
      }));
    } catch (err) {
      setAccountWorks((p) => ({
        ...p,
        [id]: { ...(p[id] || {}), loading: false, error: err.message || '获取作品失败' },
      }));
    }
  };

  // 排序后的作品列表
  const sortedWorks = (id) => {
    const w = accountWorks[id];
    if (!w || !w.list) return [];
    const arr = [...w.list];
    if (worksSort === 'digg') {
      arr.sort((a, b) => (b.statistics?.digg_count || 0) - (a.statistics?.digg_count || 0));
    } else if (worksSort === 'comment') {
      arr.sort((a, b) => (b.statistics?.comment_count || 0) - (a.statistics?.comment_count || 0));
    } else {
      arr.sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
    }
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
    <div className="account-manager fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon"><Database size={20} /></span>
          账号管理
        </h1>
        <p className="hero-subtitle">
          添加并管理抖音账号，查看详细统计数据。点击头像可查看粉丝/获赞/作品数增速与作品点赞增速。
        </p>
      </div>

      {/* 添加账号 - 醒目卡片 */}
      <div className="add-card">
        <div className="add-card-header">
          <span className="add-card-title">
            <Plus size={15} />
            添加账号
          </span>
          <div className="add-mode-tabs">
            <button
              className={`add-mode-tab${!batchMode ? ' active' : ''}`}
              onClick={() => { setBatchMode(false); setError(null); }}
            >
              单条添加
            </button>
            <button
              className={`add-mode-tab${batchMode ? ' active' : ''}`}
              onClick={() => { setBatchMode(true); setError(null); setBatchResults(null); }}
            >
              批量添加
            </button>
          </div>
        </div>

        {/* 目标分组选择（单条/批量共用） */}
        <div className="add-group-select">
          <span className="add-group-select-label">添加到分组：</span>
          <select
            className="form-input group-select"
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
          >
            <option value="">未分组</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        {!batchMode ? (
          /* 单条添加 */
          <div className="add-row">
            <div className="input-with-icon">
              <Link2 size={16} className="input-icon" />
              <input
                type="text"
                className="form-input add-input"
                placeholder="粘贴用户主页链接，例如 https://v.douyin.com/xxxxxx"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddAccount()}
              />
            </div>
            <button
              className="btn add-btn"
              onClick={handleAddAccount}
              disabled={loading || !url.trim() || !pythonRunning}
            >
              {loading ? (
                <>
                  <span className="loading-spinner"></span>
                  添加中...
                </>
              ) : (
                <>
                  <Plus size={16} />
                  添加账号
                </>
              )}
            </button>
          </div>
        ) : (
          /* 批量添加 */
          <div className="batch-add-area">
            <textarea
              className="form-input batch-textarea"
              placeholder={'每行一个链接或 sec_user_id，例如：\nhttps://v.douyin.com/xxxxxx\nhttps://www.douyin.com/user/MS4w...\nsec_user_id_1\nsec_user_id_2'}
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              rows={6}
              disabled={batchLoading}
            />
            <div className="batch-add-row">
              <span className="batch-hint">
                {batchText.trim() ? `共 ${batchText.split('\n').map(s=>s.trim()).filter(Boolean).length} 条` : '每行一个，支持主页链接 / sec_user_id'}
              </span>
              <button
                className="btn add-btn"
                onClick={handleBatchAdd}
                disabled={batchLoading || !batchText.trim() || !pythonRunning}
              >
                {batchLoading ? (
                  <>
                    <span className="loading-spinner"></span>
                    批量添加中...
                  </>
                ) : (
                  <>
                    <Plus size={16} />
                    批量添加
                  </>
                )}
              </button>
            </div>

            {/* 批量结果 */}
            {batchResults && (
              <div className="batch-results">
                <div className="batch-summary">
                  <span className="batch-sum-ok">✓ 成功 {batchResults.summary.success || 0}</span>
                  <span className="batch-sum-skip">→ 跳过 {batchResults.summary.skip || 0}</span>
                  <span className="batch-sum-fail">✗ 失败 {batchResults.summary.fail || 0}</span>
                  <span className="batch-sum-total">/ 共 {batchResults.summary.total || 0}</span>
                </div>
                <div className="batch-result-list">
                  {batchResults.results.map((r, idx) => (
                    <div key={idx} className={`batch-result-item ${r.success ? 'ok' : (r.skipped ? 'skip' : 'fail')}`}>
                      <span className="batch-result-status">
                        {r.success ? '✓' : (r.skipped ? '→' : '✗')}
                      </span>
                      <span className="batch-result-input" title={r.input}>{r.input.slice(0, 50)}{r.input.length > 50 ? '...' : ''}</span>
                      <span className="batch-result-detail">
                        {r.success ? (r.nickname || '成功') : (r.error || '失败')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="alert alert-danger" style={{ marginTop: 12 }}>
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* 两栏布局：左侧分组侧边栏 + 右侧账号列表 */}
      {accounts.length > 0 && (
        <div className="account-layout">
          {/* 左侧分组侧边栏 */}
          <aside className="group-sidebar">
            <div className="group-sidebar-header">
              <span className="group-sidebar-title">
                <Layers size={14} />
                分组
              </span>
              <button
                className="group-sidebar-mgr-btn"
                onClick={() => setShowGroupMgr(true)}
                title="管理分组"
              >
                <FolderPlus size={14} />
              </button>
            </div>
            <div className="group-sidebar-list">
              <button
                className={`group-sidebar-item${activeGroupId === 'all' ? ' active' : ''}`}
                onClick={() => setActiveGroupId('all')}
              >
                <span className="group-sidebar-item-name">全部账号</span>
                <span className="group-sidebar-item-count">{accounts.length}</span>
              </button>
              <button
                className={`group-sidebar-item${activeGroupId === 'ungrouped' ? ' active' : ''}`}
                onClick={() => setActiveGroupId('ungrouped')}
              >
                <span className="group-sidebar-item-name">未分组</span>
                <span className="group-sidebar-item-count">{accounts.filter(a => !a.group_id).length}</span>
              </button>
              {groups.length > 0 && <div className="group-sidebar-divider" />}
              {groups.map(g => (
                <button
                  key={g.id}
                  className={`group-sidebar-item${activeGroupId === g.id ? ' active' : ''}`}
                  onClick={() => setActiveGroupId(g.id)}
                  title={g.name}
                >
                  <span className="group-sidebar-item-name">{g.name}</span>
                  <span className="group-sidebar-item-count">{g.account_count}</span>
                </button>
              ))}
            </div>

            {/* 标签跨组筛选板块 */}
            {allTags.length > 0 && (
              <>
                <div className="group-sidebar-header" style={{ marginTop: 16 }}>
                  <span className="group-sidebar-title">
                    <Tag size={14} />
                    标签 (跨组筛选)
                  </span>
                  {activeTag && (
                    <button
                      className="group-sidebar-clear-tag"
                      onClick={() => setActiveTag('')}
                      title="清除标签筛选"
                    >
                      重置
                    </button>
                  )}
                </div>
                <div className="group-sidebar-list">
                  <button
                    className={`group-sidebar-item${activeTag === '' ? ' active' : ''}`}
                    onClick={() => setActiveTag('')}
                  >
                    <span className="group-sidebar-item-name">全部标签</span>
                    <span className="group-sidebar-item-count">{accounts.length}</span>
                  </button>
                  {allTags.map(tag => (
                    <button
                      key={tag}
                      className={`group-sidebar-item tag-item${activeTag === tag ? ' active' : ''}`}
                      onClick={() => setActiveTag(tag)}
                      title={`筛选跨分组包含「${tag}」标签的账号`}
                    >
                      <span className="group-sidebar-item-name">🏷️ {tag}</span>
                      <span className="group-sidebar-item-count">{allTagsMap[tag]}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* 爆款分析入口：分析当前选中的分组 */}
            <button
              className="group-sidebar-analysis-entry"
              onClick={() => {
                let target = null;
                if (activeGroupId === 'all') {
                  target = { name: '全部账号', accounts };
                } else if (activeGroupId === 'ungrouped') {
                  target = { name: '未分组', accounts: accounts.filter(a => !a.group_id) };
                } else {
                  const g = groups.find(x => x.id === activeGroupId);
                  if (g) target = { name: g.name, accounts: accounts.filter(a => a.group_id === g.id) };
                }
                if (!target || target.accounts.length === 0) {
                  alert('请先选择一个有账号的分组再进行爆款分析');
                  return;
                }
                setAnalysisGroup(target);
              }}
              title="分析当前选中分组下的爆款视频"
            >
              <Flame size={15} />
              分组爆款分析
            </button>
          </aside>

          {/* 右侧账号列表 */}
          <div className="account-main">
            {/* 标签筛选活动提示栏 */}
            {activeTag && (
              <div className="account-tag-active-bar">
                <span className="tag-active-text">
                  <Tag size={14} />
                  当前正筛选标签为 <strong className="tag-highlight">「{activeTag}」</strong> 的账号
                  {activeGroupId !== 'all' ? ` (在当前分组内)` : ` (自动跨所有分组匹配展出)`}
                </span>
                <button className="tag-clear-btn" onClick={() => setActiveTag('')}>
                  <X size={12} /> 清除标签筛选
                </button>
              </div>
            )}

            {filteredAccounts.length === 0 ? (
              <div className="empty-state-v2">
                <div className="empty-icon-wrap">
                  <Layers size={40} />
                </div>
                <div className="empty-title">该分组下暂无账号</div>
                <div className="empty-text">切换分组或在上方添加账号到该分组</div>
              </div>
            ) : (
              <div className="accounts-grid">
                {filteredAccounts.map(account => {
                  return (
                  <div key={account.sec_user_id} className="account-card-wrap">
                    <div className="account-card">
                    <div className="account-header">
                <div
                  className="account-avatar account-avatar-clickable"
                  onClick={() => setModalAccount(account)}
                  title="点击查看增速曲线"
                >
                  {account.avatar ? (
                    <img src={account.avatar} alt={account.nickname} />
                  ) : (
                    <div className="avatar-placeholder"><User size={22} /></div>
                  )}
                  <span className="avatar-trend-badge" title="增速曲线"><TrendingUp size={12} /></span>
                </div>
                <div className="account-info">
                  <div className="account-name-row">
                    {account.pinned === 1 && (
                      <span className="account-pinned-badge" title="已置顶账号">
                        <Pin size={10} /> 置顶
                      </span>
                    )}
                    <h3 className="account-name">{account.nickname}</h3>
                    {account.group_id && groupNameMap[account.group_id] && (
                      <span className="account-group-tag" title="所属分组">
                        <Layers size={10} />
                        {groupNameMap[account.group_id]}
                      </span>
                    )}
                  </div>
                  <p className="account-id">抖音号: {account.unique_id || '未设置'}</p>
                  {account.signature && (
                    <p className="account-signature">{account.signature}</p>
                  )}
                  {/* 账号标签展示与添加入口 */}
                  <div className="account-tags-row">
                    {account.tags ? (
                      account.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                        <span
                          key={t}
                          className={`account-tag-chip${activeTag === t ? ' active' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveTag(activeTag === t ? '' : t);
                          }}
                          title={`点击筛选「${t}」标签账号`}
                        >
                          #{t}
                        </span>
                      ))
                    ) : null}
                    <button
                      className="add-tag-chip-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenTagEditor(account);
                      }}
                      title="编辑/管理账号标签"
                    >
                      <Tag size={11} /> {account.tags ? '修改标签' : '+ 标签'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="account-stats">
                <div className="stat-item">
                  <div className="stat-label">粉丝</div>
                  <div className="stat-value">{formatNumber(account.follower_count)}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">关注</div>
                  <div className="stat-value">{formatNumber(account.following_count)}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">获赞</div>
                  <div className="stat-value">{formatNumber(account.total_favorited)}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">作品</div>
                  <div className="stat-value">{formatNumber(account.aweme_count)}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">喜欢</div>
                  <div className="stat-value">{formatNumber(account.favoriting_count)}</div>
                </div>
              </div>

              <div className="account-actions">
                <button
                  className={`btn btn-sm pin-toggle-btn${account.pinned ? ' is-pinned' : ''}`}
                  onClick={() => handleTogglePin(account)}
                  title={account.pinned ? '取消置顶' : '置顶账号到最上方'}
                >
                  <Pin size={13} />
                  {account.pinned ? '已置顶' : '置顶'}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleOpenTagEditor(account)}
                  title="为该账号添加或修改分类标签"
                >
                  <Tag size={13} />
                  {account.tags ? '修改标签' : '加标签'}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  title="在浏览器中打开主页"
                  onClick={() => window.electronAPI.openExternalUrl(`https://www.douyin.com/user/${account.sec_user_id}`)}
                >
                  🌐 浏览器
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleRefreshAccount(account.sec_user_id)}
                  disabled={loading}
                >
                  🔄 刷新
                </button>
                <select
                  className="form-input group-move-select"
                  value={account.group_id || ''}
                  onChange={(e) => handleMoveAccount(account.sec_user_id, e.target.value)}
                  title="移动到分组"
                >
                  <option value="">未分组</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleExportAccount(account)}
                  title="导出该账号的作品列表为 Excel（类型/发布时间/文案/合集/点赞/评论/收藏/分享/时长/链接），与主页下载导出一致"
                >
                  📊 导出 Excel
                </button>
                <button
                  className="btn btn-primary btn-sm works-toggle-btn"
                  onClick={() => openWorks(account)}
                  title="在弹窗中查看该账号的作品列表"
                >
                  <Film size={13} />
                  查看作品
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDeleteAccount(account.sec_user_id)}
                >
                  🗑️ 删除
                </button>
              </div>
              </div>
            </div>
            );
          })}
        </div>
            )}
          </div>
        </div>
      )}

      {/* 账号为空时的提示（无任何账号） */}
      {accounts.length === 0 && (
        <div className="empty-state-v2">
          <div className="empty-icon-wrap">
            <User size={40} />
          </div>
          <div className="empty-title">暂无账号</div>
          <div className="empty-text">在上方添加账号后，可查看详细统计数据</div>
        </div>
      )}

      {/* 增速弹窗 */}
      {modalAccount && (
        <ModalErrorBoundary onClose={() => setModalAccount(null)}>
          <AccountGrowthModal
            account={modalAccount}
            onClose={() => setModalAccount(null)}
          />
        </ModalErrorBoundary>
      )}

      {/* 爆款分析弹窗 */}
      {analysisGroup && (
        <ModalErrorBoundary onClose={() => setAnalysisGroup(null)}>
          <HotVideoAnalysisModal
            groupName={analysisGroup.name}
            accounts={analysisGroup.accounts}
            onClose={() => setAnalysisGroup(null)}
          />
        </ModalErrorBoundary>
      )}

      {/* 作品列表弹窗 */}
      {worksModalAccount && (() => {
        const acc = worksModalAccount;
        const w = accountWorks[acc.sec_user_id];
        const list = sortedWorks(acc.sec_user_id);
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
                      <h3>{acc.nickname || '未设置'}</h3>
                      <p>抖音号: {acc.unique_id || acc.sec_user_id} · 作品列表</p>
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

                  {w?.loading && <div className="works-loading">加载作品中...</div>}
                  {w?.error && (
                    <div className="alert alert-danger" style={{ marginTop: 8 }}>
                      <AlertCircle size={14} />
                      <span>{w.error}</span>
                    </div>
                  )}
                  {!w?.loading && !w?.error && w?.list && w.list.length === 0 && (
                    <div className="works-empty">该账号暂无公开作品</div>
                  )}
                  {w?.list && w.list.length > 0 && (
                    <div className="works-list">
                      {list.map((aw) => {
                        const digg = aw.statistics?.digg_count || 0;
                        const isHot = (digg >= 50000) ||
                                      (digg >= avgDigg * 2.5 && digg >= 2000) ||
                                      (list.length <= 3 && digg === maxDigg && digg >= 2000);
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
                                <span title={`点赞量: ${digg.toLocaleString()}`}>❤ {formatNumber(digg)}</span>
                                <span title={`评论量: ${(aw.statistics?.comment_count || 0).toLocaleString()}`}>💬 {formatNumber(aw.statistics?.comment_count || 0)}</span>
                                <span>· {new Date((aw.create_time || 0) * 1000).toLocaleDateString('zh-CN')}</span>
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

      {/* 分组管理弹窗 */}
      {showGroupMgr && (
        <div className="group-mgr-overlay" onClick={() => { setShowGroupMgr(false); setEditingGroupId(null); }}>
          <div className="group-mgr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="group-mgr-header">
              <span className="group-mgr-title">
                <Layers size={16} />
                管理分组
              </span>
              <button className="group-mgr-close" onClick={() => { setShowGroupMgr(false); setEditingGroupId(null); }}>
                <X size={16} />
              </button>
            </div>

            <div className="group-mgr-list">
              {groups.length === 0 ? (
                <div className="group-mgr-empty">还没有分组，在下方新建一个吧</div>
              ) : (
                groups.map(g => (
                  <div key={g.id} className="group-mgr-item">
                    {editingGroupId === g.id ? (
                      <>
                        <input
                          className="form-input group-mgr-rename-input"
                          value={editingGroupName}
                          onChange={(e) => setEditingGroupName(e.target.value)}
                          onKeyPress={(e) => e.key === 'Enter' && handleRenameGroup(g.id)}
                          autoFocus
                        />
                        <button className="btn btn-primary btn-sm" onClick={() => handleRenameGroup(g.id)}>
                          <Check size={13} />
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingGroupId(null)}>
                          <X size={13} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="group-mgr-name">{g.name}</span>
                        <span className="group-mgr-count">{g.account_count} 个账号</span>
                        <button
                          className="btn btn-secondary btn-sm"
                          title="重命名"
                          onClick={() => { setEditingGroupId(g.id); setEditingGroupName(g.name); }}
                        >
                          <Edit3 size={13} />
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          title="删除分组"
                          onClick={() => handleRemoveGroup(g.id, g.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="group-mgr-add">
              <input
                className="form-input group-mgr-new-input"
                placeholder="输入新分组名"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddGroup()}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAddGroup}
                disabled={!newGroupName.trim()}
              >
                <Plus size={14} />
                新建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 标签编辑模态框 */}
      {editingTagAccount && (
        <ModalErrorBoundary onClose={() => setEditingTagAccount(null)}>
          <div className="modal-overlay" onClick={() => setEditingTagAccount(null)}>
            <div className="tag-edit-modal" onClick={e => e.stopPropagation()}>
              <div className="tag-edit-header">
                <div className="tag-edit-title">
                  <div className="tag-edit-icon"><Tag size={16} /></div>
                  <div className="tag-edit-title-text">
                    <span className="tag-edit-title-main">绑定常用标签</span>
                    <span className="tag-edit-subtitle">为「{editingTagAccount.nickname || '未设置'}」设置分类标签</span>
                  </div>
                </div>
                <button className="close-btn" onClick={() => setEditingTagAccount(null)}><X size={16} /></button>
              </div>

              <div className="tag-edit-body">
                <div className="tag-edit-tip">
                  <span className="tag-edit-tip-icon">💡</span>
                  <span>只能从下方常用标签库中选择，点击标签即可勾选或取消</span>
                </div>

                {/* 常用标签选择池 (勾选式) */}
                <div className="tag-section">
                  <div className="tag-section-head">
                    <span className="tag-section-label">常用标签库</span>
                    <span className="tag-section-count">
                      {(Array.isArray(customPresetTags) ? customPresetTags : []).length} 个标签
                    </span>
                  </div>
                  <div className="preset-tags-grid">
                    {(Array.isArray(customPresetTags) ? customPresetTags : []).map(tag => {
                      const isChecked = Array.isArray(selectedAccountTags) && selectedAccountTags.includes(tag);
                      return (
                        <div
                          key={tag}
                          className={`tag-toggle-chip${isChecked ? ' selected' : ''}`}
                          onClick={() => handleToggleTagSelection(tag)}
                          title={isChecked ? `已选择 #${tag}（点击取消）` : `绑定 #${tag}`}
                        >
                          <span className="tag-toggle-check">{isChecked ? '✓' : '+'}</span>
                          <span className="tag-toggle-name">{tag}</span>
                          <span
                            className="tag-toggle-del"
                            onClick={(e) => handleDeletePresetTag(tag, e)}
                            title="从常用标签库中移除该标签"
                          >
                            <X size={10} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 新建常用标签 */}
                <div className="tag-section">
                  <div className="tag-section-head">
                    <span className="tag-section-label">新建标签</span>
                    <span className="tag-section-count">创建后可直接勾选</span>
                  </div>
                  <div className="add-preset-tag-bar">
                    <input
                      type="text"
                      className="form-input tag-edit-input"
                      placeholder="输入标签名称，如：男博主"
                      value={newPresetInput}
                      onChange={e => setNewPresetInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreateNewPresetTag()}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleCreateNewPresetTag}
                      disabled={!newPresetInput.trim()}
                      style={{ flexShrink: 0 }}
                    >
                      <Plus size={13} /> 新建
                    </button>
                  </div>
                </div>

                {/* 已选标签预览（点击徽章可快速移除） */}
                <div className="selected-tags-preview">
                  <div className="selected-tags-head">
                    <span className="selected-tags-label">已选标签</span>
                    <span className="selected-tags-count">
                      {(Array.isArray(selectedAccountTags) ? selectedAccountTags : []).length} 个
                    </span>
                  </div>
                  {Array.isArray(selectedAccountTags) && selectedAccountTags.length > 0 ? (
                    <div className="selected-tags-chips">
                      {selectedAccountTags.map(t => (
                        <span
                          key={t}
                          className="selected-tag-badge"
                          onClick={() => handleToggleTagSelection(t)}
                          title="点击取消该标签"
                        >
                          #{t} <X size={10} />
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="selected-tags-empty">
                      <Tag size={13} />
                      <span>暂未选择任何标签</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="tag-edit-footer">
                <button className="btn btn-secondary" onClick={() => setEditingTagAccount(null)}>取消</button>
                <button className="btn btn-primary" onClick={handleSaveTags}>保存绑定</button>
              </div>
            </div>
          </div>
        </ModalErrorBoundary>
      )}
    </div>
  );
}

/**
 * 弹窗 ErrorBoundary：捕获弹窗内部一切渲染异常，避免全屏白屏崩溃
 */
export class ModalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ModalErrorBoundary] 捕获弹窗异常:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="account-modal-overlay" onClick={this.props.onClose}>
          <div className="account-modal" onClick={(e) => e.stopPropagation()} style={{ padding: 28, maxWidth: 480, textAlign: 'center', background: 'var(--bg-surface, #1e293b)', borderRadius: 12, border: '1px solid var(--border-default, rgba(255,255,255,0.1))' }}>
            <h3 style={{ color: '#ef4444', marginBottom: 12, fontSize: 16 }}>⚠️ 弹窗加载遇到异常</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary, #cbd5e1)', marginBottom: 20, wordBreak: 'break-all' }}>
              {this.state.error?.message || String(this.state.error || '未知错误')}
            </p>
            <button className="btn btn-primary" onClick={this.props.onClose}>关闭弹窗</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 账号增速弹窗：左栏作品列表（可排序），右栏图表区。
 * 数据来源：DB 中的 account_history / account_works / work_stats_history。
 * 供 AccountManager 与 MyAccounts（我的账号）复用。
 */
export function AccountGrowthModal({ account, onClose }) {
  const targetAcc = account || {};
  const secUserId = targetAcc.sec_user_id || targetAcc.sec_uid || '';
  const nickname = targetAcc.nickname || '未知账号';
  const avatar = targetAcc.avatar || '';
  const uniqueId = targetAcc.unique_id || '未设置';
  const followerCount = targetAcc.follower_count || 0;
  const totalFavorited = targetAcc.total_favorited || 0;
  const awemeCount = targetAcc.aweme_count || 0;

  const [history, setHistory] = useState([]);      // 账号增速历史
  const [works, setWorks] = useState([]);          // 当前作品清单（含最新快照）
  const [workStatsCache, setWorkStatsCache] = useState({}); // { awemeId: history[] }
  const [selectedWorkId, setSelectedWorkId] = useState(null); // 右栏展示的作品
  const [worksSortMetric, setWorksSortMetric] = useState('newest'); // newest|digg|comment|share|collect
  const [worksSortMode, setWorksSortMode] = useState('absolute'); // absolute|delta|percent
  const [worksSortPeriod, setWorksSortPeriod] = useState('day');  // day|week|month|total: 增速时间范围
  const [chartMode, setChartMode] = useState('percent'); // percent|absolute：曲线展示模式
  const [timeDimension, setTimeDimension] = useState('raw'); // raw|day|week|month：时间维度过滤
  const [loading, setLoading] = useState(true);

  const [activeMetric, setActiveMetric] = useState('all'); // followerCount|totalFavorited|awemeCount|all
  const [activeWorkMetric, setActiveWorkMetric] = useState('all'); // diggCount|commentCount|collectCount|shareCount|all

  // 安全获取某作品在指定周期下的增幅数据
  const getWorkGrowth = (w, metric, period) => {
    if (!w) return { delta: 0, percent: 0 };
    const growthObj = w[`${period}Growth`] || w.dayGrowth;
    if (!growthObj) {
      return {
        delta: w[`${metric}Delta`] || 0,
        percent: w[`${metric}Percent`] || 0,
      };
    }
    return {
      delta: growthObj[`${metric}Delta`] || 0,
      percent: growthObj[`${metric}Percent`] || 0,
    };
  };

  // 统一内联增速渲染
  const renderMetricGrowth = (w, metricKey) => {
    const isSortedMetric = worksSortMetric === metricKey;
    if (!isSortedMetric || worksSortMode === 'absolute') return null;

    const growth = getWorkGrowth(w, metricKey, worksSortPeriod);
    if (worksSortMode === 'delta') {
      const formatted = growth.delta >= 0 ? `+${growth.delta.toLocaleString()}` : growth.delta.toLocaleString();
      return <span style={{ fontWeight: 'bold', fontSize: '11px', opacity: 0.95 }}> ({formatted})</span>;
    } else if (worksSortMode === 'percent') {
      const formatted = growth.percent >= 0 ? `+${growth.percent.toFixed(1)}%` : `${growth.percent.toFixed(1)}%`;
      return <span style={{ fontWeight: 'bold', fontSize: '11px', opacity: 0.95 }}> ({formatted})</span>;
    }
    return null;
  };

  // 当切换为“数量”模式时，如果当前是“all”，自动切换到首个单项指标聚焦，防止 Y 轴量程被拉扁
  useEffect(() => {
    if (chartMode === 'absolute') {
      if (activeMetric === 'all') setActiveMetric('followerCount');
      if (activeWorkMetric === 'all') setActiveWorkMetric('diggCount');
    }
  }, [chartMode, activeMetric, activeWorkMetric]);

  // 拉取账号增速历史 + 作品清单
  useEffect(() => {
    let cancelled = false;
    if (!secUserId) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const [histRes, worksRes] = await Promise.all([
          window.electronAPI?.accountGetHistory?.(secUserId).catch(() => null),
          window.electronAPI?.accountGetWorks?.(secUserId).catch(() => null),
        ]);
        if (cancelled) return;
        setHistory(histRes?.history || []);
        setWorks(worksRes?.works || []);
      } catch (err) {
        console.error('[AccountModal] 加载失败:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [secUserId]);

  // 排序后的作品列表
  const sortedWorks = useMemo(() => {
    const arr = [...works];
    if (worksSortMetric === 'newest') {
      arr.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
      return arr;
    }

    arr.sort((a, b) => {
      if (worksSortMode === 'absolute') {
        const valA = a[`${worksSortMetric}Count`] || 0;
        const valB = b[`${worksSortMetric}Count`] || 0;
        return valB - valA;
      } else {
        const growthA = getWorkGrowth(a, worksSortMetric, worksSortPeriod);
        const growthB = getWorkGrowth(b, worksSortMetric, worksSortPeriod);
        const valA = worksSortMode === 'delta' ? growthA.delta : growthA.percent;
        const valB = worksSortMode === 'delta' ? growthB.delta : growthB.percent;
        return valB - valA;
      }
    });
    return arr;
  }, [works, worksSortMetric, worksSortMode, worksSortPeriod]);

  // 默认选中第一个作品
  useEffect(() => {
    if (!selectedWorkId && sortedWorks.length > 0) {
      setSelectedWorkId(sortedWorks[0].awemeId);
    }
    if (selectedWorkId && !sortedWorks.some(w => w.awemeId === selectedWorkId)) {
      setSelectedWorkId(sortedWorks[0]?.awemeId || null);
    }
  }, [sortedWorks, selectedWorkId]);

  // 选中作品 → 拉时序
  useEffect(() => {
    if (!selectedWorkId) return;
    if (workStatsCache[selectedWorkId]) return;
    (async () => {
      try {
        const res = await window.electronAPI.accountGetWorkStats(selectedWorkId);
        setWorkStatsCache((prev) => ({ ...prev, [selectedWorkId]: res?.history || [] }));
      } catch (err) {
        console.error('[AccountModal] 读取作品时序失败:', err);
        setWorkStatsCache((prev) => ({ ...prev, [selectedWorkId]: [] }));
      }
    })();
  }, [selectedWorkId, workStatsCache]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 账号级增速指标（使用完整的历史计算）
  const followerGrowth = growthRate(history, 'followerCount');
  const favoritedGrowth = growthRate(history, 'totalFavorited');
  const awemeGrowth = growthRate(history, 'awemeCount');
  const followerDelta = totalDelta(history, 'followerCount');
  const favoritedDelta = totalDelta(history, 'totalFavorited');

  // 按维度过滤和聚合数据
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

  // 账号级图表用数据：粉丝/获赞/作品数三条线
  const accountChartData = useMemo(() => {
    const rawData = history.map(p => ({
      time: p.time,
      followerCount: p.followerCount,
      totalFavorited: p.totalFavorited,
      awemeCount: p.awemeCount,
    }));
    return aggregateHistory(rawData, timeDimension);
  }, [history, timeDimension]);

  // 选中作品
  const selectedWork = sortedWorks.find(w => w.awemeId === selectedWorkId) || null;
  const wHist = selectedWork ? (workStatsCache[selectedWork.awemeId] || []) : [];
  const diggDelta = totalDelta(wHist, 'diggCount');
  const commentDelta = totalDelta(wHist, 'commentCount');
  const shareDelta = totalDelta(wHist, 'shareCount');
  const collectDelta = totalDelta(wHist, 'collectCount');
  const diggGrowth = growthRate(wHist, 'diggCount');
  const shareGrowth = growthRate(wHist, 'shareCount');
  const collectGrowth = growthRate(wHist, 'collectCount');

  const aggregatedWHist = useMemo(() => {
    return aggregateHistory(wHist, timeDimension);
  }, [wHist, timeDimension]);

  return (
    <div className="account-modal-overlay" onClick={onClose}>
      <div className="account-modal account-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="account-modal-head">
          <div className="account-modal-title">
            <div className="account-modal-avatar">
              {avatar ? (
                <img src={avatar} alt={nickname} />
              ) : (
                <div className="avatar-placeholder"><User size={22} /></div>
              )}
            </div>
            <div>
              <h3>{nickname}</h3>
              <p>抖音号: {uniqueId} · 增速监控</p>
            </div>
          </div>
          <button className="account-modal-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="account-modal-body account-modal-body-split">
          {loading ? (
            <div className="account-modal-loading">加载增速数据中...</div>
          ) : (
            <>
              {/* 左栏：作品列表 */}
              <div className="am-left">
                <div className="am-left-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="account-modal-section-title">
                      <Film size={15} /> 作品列表
                      <span className="am-count">{sortedWorks.length}</span>
                    </span>
                  </div>
                  
                  {/* 第一排：指标选择 */}
                  <div className="am-sort" style={{ flexWrap: 'wrap', gap: '4px' }}>
                    {[
                      { id: 'newest', label: '最新' },
                      { id: 'digg', label: '点赞' },
                      { id: 'comment', label: '评论' },
                      { id: 'share', label: '分享' },
                      { id: 'collect', label: '收藏' },
                      { id: 'play', label: '播放' },
                    ].map((o) => (
                      <button
                        key={o.id}
                        className={`am-sort-chip${worksSortMetric === o.id ? ' active' : ''}`}
                        onClick={() => setWorksSortMetric(o.id)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>

                  {/* 第二排：时间范围与数据类型选择 */}
                  {worksSortMetric !== 'newest' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px dashed var(--border-muted)', paddingTop: '6px', marginTop: '2px' }}>
                      <div className="am-sort" style={{ gap: '4px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', alignSelf: 'center', marginRight: '4px' }}>时间范围:</span>
                        {[
                          { id: 'day', label: '日增' },
                          { id: 'week', label: '周增' },
                          { id: 'month', label: '月增' },
                          { id: 'total', label: '累计' },
                        ].map((p) => (
                          <button
                            key={p.id}
                            className={`am-sort-chip${worksSortPeriod === p.id ? ' active' : ''}`}
                            onClick={() => setWorksSortPeriod(p.id)}
                            style={{ padding: '2px 8px', height: '22px', fontSize: '11px', lineHeight: '16px' }}
                            disabled={worksSortMode === 'absolute'}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <div className="am-sort" style={{ gap: '4px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', alignSelf: 'center', marginRight: '4px' }}>数据类型:</span>
                        <button
                          className={`am-sort-chip${worksSortMode === 'absolute' ? ' active' : ''}`}
                          onClick={() => setWorksSortMode('absolute')}
                          style={{ padding: '2px 8px', height: '22px', fontSize: '11px', lineHeight: '16px' }}
                        >
                          总量
                        </button>
                        <button
                          className={`am-sort-chip${worksSortMode === 'delta' ? ' active' : ''}`}
                          onClick={() => setWorksSortMode('delta')}
                          style={{ padding: '2px 8px', height: '22px', fontSize: '11px', lineHeight: '16px' }}
                        >
                          增量
                        </button>
                        <button
                          className={`am-sort-chip${worksSortMode === 'percent' ? ' active' : ''}`}
                          onClick={() => setWorksSortMode('percent')}
                          style={{ padding: '2px 8px', height: '22px', fontSize: '11px', lineHeight: '16px' }}
                        >
                          增幅 %
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="am-play-note">
                  ▶ 播放量：仅绑定自己的抖音账号（我的账号）抓取时有值；他人主页抖音不返回。
                </div>

                {sortedWorks.length === 0 ? (
                  <div className="account-modal-empty">暂无作品，等待监控周期抓取</div>
                ) : (
                  <div className="am-works-list">
                    {(() => {
                      const diggs = sortedWorks.map(w => w.diggCount || 0);
                      const maxDigg = Math.max(...diggs, 0);
                      const avgDigg = diggs.length > 0 ? (diggs.reduce((a, b) => a + b, 0) / diggs.length) : 0;
                      return sortedWorks.map((w) => {
                        const active = w.awemeId === selectedWorkId;
                        const digg = w.diggCount || 0;
                        const isHot = (digg >= 50000) || 
                                      (digg >= avgDigg * 2.5 && digg >= 2000) || 
                                      (sortedWorks.length <= 3 && digg === maxDigg && digg >= 2000);
                        return (
                          <div
                            key={w.awemeId}
                            className={`am-work-item${active ? ' active' : ''}${isHot ? ' hot' : ''}`}
                            onClick={() => setSelectedWorkId(w.awemeId)}
                          >
                            {isHot && <span className="am-work-hot-badge">🔥 爆款</span>}
                            <div className="am-work-cover">
                              {w.cover ? (
                                <img src={w.cover} alt="" />
                              ) : (
                                <div className="work-cover-ph"><Film size={16} /></div>
                              )}
                            </div>
                            <div className="am-work-main">
                              <div className="am-work-title">{(w.desc || '无标题').slice(0, 50)}</div>
                              <div className="am-work-stats" style={{ width: '100%', flexWrap: 'wrap', gap: '8px' }}>
                                <span
                                  title={`播放量: ${(w.playCount || 0).toLocaleString()}`}
                                  style={worksSortMetric === 'play' ? { color: 'var(--ops-accent)', fontWeight: 'bold' } : {}}
                                >
                                  ▶ {(w.playCount || 0).toLocaleString()}
                                  {renderMetricGrowth(w, 'play')}
                                </span>
                                <span
                                  title={`点赞量: ${digg.toLocaleString()}`}
                                  style={worksSortMetric === 'digg' ? { color: 'var(--danger)', fontWeight: 'bold' } : {}}
                                >
                                  <Heart size={11} /> {digg.toLocaleString()}
                                  {renderMetricGrowth(w, 'digg')}
                                </span>
                                <span
                                  title={`收藏量: ${(w.collectCount || 0).toLocaleString()}`}
                                  style={worksSortMetric === 'collect' ? { color: 'var(--ops-accent)', fontWeight: 'bold' } : {}}
                                >
                                  ⭐ {(w.collectCount || 0).toLocaleString()}
                                  {renderMetricGrowth(w, 'collect')}
                                </span>
                                <span
                                  title={`分享量: ${(w.shareCount || 0).toLocaleString()}`}
                                  style={worksSortMetric === 'share' ? { color: 'var(--success)', fontWeight: 'bold' } : {}}
                                >
                                  ↗ {(w.shareCount || 0).toLocaleString()}
                                  {renderMetricGrowth(w, 'share')}
                                </span>
                                <span
                                  title={`评论量: ${(w.commentCount || 0).toLocaleString()}`}
                                  style={worksSortMetric === 'comment' ? { color: 'var(--accent)', fontWeight: 'bold' } : {}}
                                >
                                  💬 {(w.commentCount || 0).toLocaleString()}
                                  {renderMetricGrowth(w, 'comment')}
                                </span>
                                <span
                                  className="work-link-icon"
                                  title="在浏览器中打开此视频"
                                  onClick={(e) => { e.stopPropagation(); window.electronAPI.openExternalUrl(`https://www.douyin.com/video/${w.awemeId}`); }}
                                  style={{ cursor: 'pointer', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', color: 'var(--text-tertiary)' }}
                                >
                                  <ExternalLink size={12} />
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>

              {/* 右栏：图表区 */}
              <div className="am-right">
                {/* 图表模式切换：增幅% / 数量 */}
                <div className="am-chart-mode">
                  <span className="am-chart-mode-label">曲线展示</span>
                  <button
                    className={`am-sort-chip${chartMode === 'percent' ? ' active' : ''}`}
                    onClick={() => setChartMode('percent')}
                    title="相对首点的增幅百分比，不同量级序列可同图对比趋势"
                  >增幅%</button>
                  <button
                    className={`am-sort-chip${chartMode === 'absolute' ? ' active' : ''}`}
                    onClick={() => setChartMode('absolute')}
                    title="显示真实数量（不同量级序列可能互相挤压）"
                  >数量</button>
                  {chartMode === 'percent' && (
                    <button
                      className={`am-sort-chip${activeMetric === 'all' ? ' active' : ''}`}
                      onClick={() => setActiveMetric('all')}
                      title="同时对比展示粉丝、获赞和作品数的百分比趋势"
                      style={{ marginLeft: '12px' }}
                    >对比全部</button>
                  )}
                  <span className="am-chart-mode-tip">
                    {chartMode === 'absolute' ? '点击下方卡片切换查看单项曲线' : '点击下方卡片单选，或点击对比全部'}
                  </span>
                </div>

                {/* 时间维度切换：实时 / 天 / 周 / 月 */}
                <div className="am-chart-mode" style={{ marginTop: '10px' }}>
                  <span className="am-chart-mode-label">时间维度</span>
                  <button
                    className={`am-sort-chip${timeDimension === 'raw' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('raw')}
                    title="显示实时采样数据（展示最近48小时）"
                  >实时</button>
                  <button
                    className={`am-sort-chip${timeDimension === 'day' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('day')}
                    title="按天汇总展示趋势"
                  >天</button>
                  <button
                    className={`am-sort-chip${timeDimension === 'week' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('week')}
                    title="按周汇总展示趋势"
                  >周</button>
                  <button
                    className={`am-sort-chip${timeDimension === 'month' ? ' active' : ''}`}
                    onClick={() => setTimeDimension('month')}
                    title="按月汇总展示趋势"
                  >月</button>
                  <span className="am-chart-mode-tip">可切换日、周、月维度观察长期趋势</span>
                </div>

                {/* 账号级增速 */}
                <section className="account-modal-section am-right-section">
                  <div className="account-modal-section-head">
                    <span className="account-modal-section-title">
                      <Activity size={15} /> 账号增速
                    </span>
                    <span className="account-modal-section-hint">
                      {history.length > 0
                        ? `${history.length} 原始点 · 点击下方卡片切换指标`
                        : '暂无采样数据'}
                    </span>
                  </div>

                  <div className="account-modal-stats">
                    <div
                      className={`am-stat clickable ${activeMetric === 'followerCount' ? 'active' : ''} ${followerGrowth > 0 ? 'up' : (followerGrowth < 0 ? 'down' : '')}`}
                      onClick={() => setActiveMetric('followerCount')}
                      title="点击查看粉丝趋势"
                    >
                      <div className="am-stat-label">粉丝</div>
                      <div className="am-stat-value">{(followerCount || 0).toLocaleString()}</div>
                      <div className="am-stat-growth">
                        {followerGrowth !== 0 && `${followerGrowth > 0 ? '+' : ''}${formatCount(followerGrowth)}/h`}
                        {followerDelta !== 0 && ` · ${followerDelta > 0 ? '+' : ''}${formatCount(followerDelta)}`}
                      </div>
                    </div>
                    <div
                      className={`am-stat clickable ${activeMetric === 'totalFavorited' ? 'active' : ''} ${favoritedGrowth > 0 ? 'up' : (favoritedGrowth < 0 ? 'down' : '')}`}
                      onClick={() => setActiveMetric('totalFavorited')}
                      title="点击查看获赞趋势"
                    >
                      <div className="am-stat-label">获赞</div>
                      <div className="am-stat-value">{(totalFavorited || 0).toLocaleString()}</div>
                      <div className="am-stat-growth">
                        {favoritedGrowth !== 0 && `${favoritedGrowth > 0 ? '+' : ''}${formatCount(favoritedGrowth)}/h`}
                        {favoritedDelta !== 0 && ` · ${favoritedDelta > 0 ? '+' : ''}${formatCount(favoritedDelta)}`}
                      </div>
                    </div>
                    <div
                      className={`am-stat clickable ${activeMetric === 'awemeCount' ? 'active' : ''} ${awemeGrowth > 0 ? 'up' : ''}`}
                      onClick={() => setActiveMetric('awemeCount')}
                      title="点击查看作品数趋势"
                    >
                      <div className="am-stat-label">作品数</div>
                      <div className="am-stat-value">{(awemeCount || 0).toLocaleString()}</div>
                      <div className="am-stat-growth">
                        {awemeGrowth !== 0 && `${awemeGrowth > 0 ? '+' : ''}${formatCount(awemeGrowth)}/h`}
                      </div>
                    </div>
                  </div>

                  {accountChartData.length >= 2 ? (
                    <div className="account-modal-chart">
                      <TrendChart
                        data={accountChartData}
                        series={(() => {
                          const allSeries = [
                            { key: 'followerCount', name: '粉丝', color: 'var(--ops-accent)' },
                            { key: 'totalFavorited', name: '获赞', color: 'var(--danger)' },
                            { key: 'awemeCount', name: '作品数', color: 'var(--accent)' },
                          ];
                          if (activeMetric === 'all') return allSeries;
                          return allSeries.filter(s => s.key === activeMetric);
                        })()}
                        mode="line"
                        height={200}
                        valueMode={chartMode}
                      />
                    </div>
                  ) : (
                    <div className="account-modal-empty">
                      数据点不足，需至少 2 个采样点
                      {timeDimension !== 'raw' && <span className="am-empty-sub-hint" style={{ fontSize: '11px', color: 'var(--text-tertiary)', display: 'block', marginTop: '4px' }}>（当前选择的是『{timeDimension === 'day' ? '天' : timeDimension === 'week' ? '周' : '月'}』维度，需要更长时间跨度的数据积累）</span>}
                    </div>
                  )}
                </section>

                {/* 选中作品增速 */}
                <section className="account-modal-section am-right-section">
                  <div className="account-modal-section-head">
                    <span className="account-modal-section-title">
                      <TrendingUp size={15} /> 作品增速
                      {selectedWork && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <span className="am-work-name">{(selectedWork.desc || '无标题').slice(0, 24)}</span>
                          <button
                            className="am-sort-chip"
                            style={{ padding: '2px 6px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '3px' }}
                            onClick={() => window.electronAPI.openExternalUrl(`https://www.douyin.com/video/${selectedWork.awemeId}`)}
                            title="在外部浏览器中打开视频"
                          >
                            <ExternalLink size={11} /> 视频链接
                          </button>
                        </span>
                      )}
                    </span>
                  </div>

                  {!selectedWork ? (
                    <div className="account-modal-empty">请在左侧选择作品</div>
                  ) : (
                    <>
                      <div className="am-work-growth-bar">
                        {diggDelta !== 0 && (
                          <span className={`growth-chip ${diggDelta > 0 ? 'up' : 'down'}`}>
                            ❤ 增量 {diggDelta > 0 ? '+' : ''}{formatCount(diggDelta)}
                          </span>
                        )}
                        {collectDelta !== 0 && (
                          <span className={`growth-chip ${collectDelta > 0 ? 'up' : 'down'}`}>
                            ⭐ 增量 {collectDelta > 0 ? '+' : ''}{formatCount(collectDelta)}
                          </span>
                        )}
                        {shareDelta !== 0 && (
                          <span className={`growth-chip ${shareDelta > 0 ? 'up' : 'down'}`}>
                            ↗ 增量 {shareDelta > 0 ? '+' : ''}{formatCount(shareDelta)}
                          </span>
                        )}
                        {commentDelta !== 0 && (
                          <span className={`growth-chip ${commentDelta > 0 ? 'up' : 'down'}`}>
                            💬 增量 {commentDelta > 0 ? '+' : ''}{formatCount(commentDelta)}
                          </span>
                        )}
                        {diggGrowth !== 0 && (
                          <span className="growth-chip rate">
                            ❤ {diggGrowth > 0 ? '+' : ''}{formatCount(diggGrowth)}/h
                          </span>
                        )}
                        {collectGrowth !== 0 && (
                          <span className="growth-chip rate">
                            ⭐ {collectGrowth > 0 ? '+' : ''}{formatCount(collectGrowth)}/h
                          </span>
                        )}
                        {shareGrowth !== 0 && (
                          <span className="growth-chip rate">
                            ↗ {shareGrowth > 0 ? '+' : ''}{formatCount(shareGrowth)}/h
                          </span>
                        )}
                      </div>

                      <div className="am-work-metric-selector" style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                        <button
                          className={`am-sort-chip${activeWorkMetric === 'diggCount' ? ' active' : ''}`}
                          onClick={() => setActiveWorkMetric('diggCount')}
                        >❤ 点赞</button>
                        <button
                          className={`am-sort-chip${activeWorkMetric === 'commentCount' ? ' active' : ''}`}
                          onClick={() => setActiveWorkMetric('commentCount')}
                        >💬 评论</button>
                        <button
                          className={`am-sort-chip${activeWorkMetric === 'collectCount' ? ' active' : ''}`}
                          onClick={() => setActiveWorkMetric('collectCount')}
                        >⭐ 收藏</button>
                        <button
                          className={`am-sort-chip${activeWorkMetric === 'shareCount' ? ' active' : ''}`}
                          onClick={() => setActiveWorkMetric('shareCount')}
                        >↗ 分享</button>
                        {chartMode === 'percent' && (
                          <button
                            className={`am-sort-chip${activeWorkMetric === 'all' ? ' active' : ''}`}
                            onClick={() => setActiveWorkMetric('all')}
                          >对比全部</button>
                        )}
                      </div>

                      <div className="account-modal-chart">
                        {aggregatedWHist.length >= 2 ? (
                          <TrendChart
                            data={aggregatedWHist}
                            series={(() => {
                              const allWorkSeries = [
                                { key: 'diggCount', name: '点赞', color: 'var(--danger)' },
                                { key: 'shareCount', name: '分享', color: 'var(--success)' },
                                { key: 'collectCount', name: '收藏', color: 'var(--ops-accent)' },
                                { key: 'commentCount', name: '评论', color: 'var(--accent)' },
                              ];
                              if (activeWorkMetric === 'all') return allWorkSeries;
                              return allWorkSeries.filter(s => s.key === activeWorkMetric);
                            })()}
                            mode="line"
                            height={220}
                            valueMode={chartMode}
                          />
                        ) : (
                          <div className="account-modal-empty">
                            数据点不足，需至少 2 个采样点
                            {timeDimension !== 'raw' && <span className="am-empty-sub-hint" style={{ fontSize: '11px', color: 'var(--text-tertiary)', display: 'block', marginTop: '4px' }}>（当前选择的是『{timeDimension === 'day' ? '天' : timeDimension === 'week' ? '周' : '月'}』维度，需要更长时间跨度的数据积累）</span>}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AccountManager;
