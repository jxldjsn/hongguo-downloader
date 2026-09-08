import React, { useState, useEffect, useMemo } from 'react';
import { arrayToCSV, downloadCSV } from '../utils/csvExport';
import { Flame, X, BarChart3, Download, Link2, MessageSquare, Heart, Play, Share2, Bookmark, ExternalLink, Film } from './icons';
import './HotVideoAnalysisModal.css';

// 格式化数字（万/亿）
function fmt(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(2) + '亿';
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + 'w';
  return String(Math.round(n));
}

// 发布时间格式化（createTime 秒级时间戳）
function fmtDate(ts) {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

// 增长周期标签映射
const PERIOD_LABEL = { day: '近24小时', week: '近7天', month: '近30天', total: '总计' };

// 爆款分级阈值
const HOT_THRESHOLD = 70;   // ≥70 爆款
const POTENTIAL_THRESHOLD = 50; // 50-70 潜力

/**
 * 计算单条作品的爆款指数（0-100）
 * 仅依赖发布时间 + 快照统计数（点赞/评论/播放/收藏），不依赖增长时序数据，
 * 这样即使用户没跑过监控、没有 work_stats_history 也能算。
 * 综合 3 个维度，各项归一化到本组最大值：
 *  - 点赞密度 50%：点赞数 / 发布天数（越新且赞越多越高）
 *  - 互动率   25%：(赞+评+藏) / 播放量（转化好加分）
 *  - 绝对热度 25%：点赞数绝对值
 * @param {Object} w - 作品对象
 * @param {Object} max - 本组各维度最大值 {density, interact, digg}
 * @returns {number} 0-100
 */
function calcHotScore(w, max) {
  const now = Date.now() / 1000;
  const days = Math.max(1, (now - (w.createTime || 0)) / 86400);
  const digg = w.diggCount || 0;
  const comment = w.commentCount || 0;
  const play = w.playCount || 0;
  const collect = w.collectCount || 0;

  const density = digg / days;
  const interact = play > 0 ? (digg + comment + collect) / play : 0;

  const scoreDensity = max.density > 0 ? (density / max.density) * 50 : 0;
  const scoreInteract = max.interact > 0 ? (interact / max.interact) * 25 : 0;
  const scoreDigg = max.digg > 0 ? (digg / max.digg) * 25 : 0;

  return Math.round(scoreDensity + scoreInteract + scoreDigg);
}

/**
 * 给本组所有作品计算爆款指数（归一化基准 = 本组最大值）
 * @param {Array} works
 * @returns {Array} 带 hotScore 字段的新数组
 */
function withHotScores(works) {
  if (!works.length) return works;
  const now = Date.now() / 1000;
  const max = { density: 0, interact: 0, digg: 0 };
  works.forEach(w => {
    const days = Math.max(1, (now - (w.createTime || 0)) / 86400);
    const digg = w.diggCount || 0;
    const play = w.playCount || 0;
    const collect = w.collectCount || 0;
    const comment = w.commentCount || 0;
    const density = digg / days;
    const interact = play > 0 ? (digg + comment + collect) / play : 0;
    if (density > max.density) max.density = density;
    if (interact > max.interact) max.interact = interact;
    if (digg > max.digg) max.digg = digg;
  });
  return works.map(w => {
    const score = calcHotScore(w, max);
    const level = score >= HOT_THRESHOLD ? 'hot' : (score >= POTENTIAL_THRESHOLD ? 'potential' : 'normal');
    return { ...w, hotScore: score, hotLevel: level };
  });
}

/**
 * 爆款分析弹窗
 * 聚合指定分组下所有账号的作品，支持按发布时间/点赞量/点赞增长/播放量筛选、多维度排序、导出Excel、复制视频链接。
 *
 * @param {string} groupName - 分组名
 * @param {Array} accounts - 该分组的账号数组 [{sec_user_id, nickname, avatar, ...}]
 * @param {Function} onClose - 关闭回调
 */
function HotVideoAnalysisModal({ groupName, accounts, onClose }) {
  const [loading, setLoading] = useState(true);
  const [allWorks, setAllWorks] = useState([]);

  // 筛选条件
  const [minDigg, setMinDigg] = useState('');
  const [maxDigg, setMaxDigg] = useState('');
  const [minPlay, setMinPlay] = useState('');
  const [maxPlay, setMaxPlay] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [publishDays, setPublishDays] = useState(''); // 发布至今N天内（与 dateFrom/dateTo 互斥）
  const [growthPeriod, setGrowthPeriod] = useState('week'); // day/week/month/total
  const [minGrowth, setMinGrowth] = useState('');
  const [onlyHot, setOnlyHot] = useState(false); // 仅看爆款/潜力

  // 排序
  const [sortBy, setSortBy] = useState('hotScore'); // hotScore/diggDensity/diggCount/diggGrowth/createTime/playCount
  const [sortDir, setSortDir] = useState('desc'); // desc/asc

  const [copyTip, setCopyTip] = useState('');

  // 并行拉取所有账号的作品并合并
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const results = await Promise.all(
        accounts.map(async (a) => {
          let res = await window.electronAPI.accountGetWorks(a.sec_user_id).catch(() => null);
          // 数据库中作品为空、或统计全为 0（旧版本曾把原始 aweme 的 statistics 写丢），
          // 且属于我的账号（带 uid）时，主动抓取落库并读取
          const ws = (res && res.works) || [];
          const stale = ws.length === 0 ||
            ws.every(w => !(w.diggCount || w.commentCount || w.playCount || w.shareCount || w.collectCount));
          if (stale && a.uid) {
            const myRes = await window.electronAPI.myAccountWorks(a.uid).catch(() => null);
            if (myRes && myRes.success) {
              res = await window.electronAPI.accountGetWorks(a.sec_user_id).catch(() => null);
            }
          }
          return res;
        })
      );
      if (cancelled) return;
      const merged = [];
      results.forEach((res, idx) => {
        const acc = accounts[idx];
        (res?.works || []).forEach(w => {
          merged.push({
            ...w,
            authorName: acc.nickname,
            authorAvatar: acc.avatar,
            secUserId: acc.sec_user_id,
          });
        });
      });
      setAllWorks(withHotScores(merged));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [accounts]);

  // 筛选 + 排序
  const filteredWorks = useMemo(() => {
    const list = allWorks.filter(w => {
      // 点赞范围
      if (minDigg !== '' && (w.diggCount || 0) < +minDigg) return false;
      if (maxDigg !== '' && (w.diggCount || 0) > +maxDigg) return false;
      // 播放范围
      if (minPlay !== '' && (w.playCount || 0) < +minPlay) return false;
      if (maxPlay !== '' && (w.playCount || 0) > +maxPlay) return false;
      // 发布至今N天内（与日期范围互斥）
      if (publishDays !== '') {
        const daysSec = +publishDays * 86400;
        if ((w.createTime || 0) < Date.now() / 1000 - daysSec) return false;
      } else if (dateFrom || dateTo) {
        // 发布时间（createTime 秒级 -> 毫秒比较）
        const t = (w.createTime || 0) * 1000;
        if (dateFrom && t < new Date(dateFrom + 'T00:00:00').getTime()) return false;
        if (dateTo && t > new Date(dateTo + 'T23:59:59').getTime()) return false;
      }
      // 点赞增长阈值（按所选周期）
      const g = w[growthPeriod + 'Growth'] || {};
      if (minGrowth !== '' && (g.diggDelta || 0) < +minGrowth) return false;
      // 仅看爆款/潜力
      if (onlyHot && w.hotLevel === 'normal') return false;
      return true;
    });

    const getSortVal = (w) => {
      if (sortBy === 'hotScore') return w.hotScore || 0;
      if (sortBy === 'diggGrowth') return (w[growthPeriod + 'Growth'] || {}).diggDelta || 0;
      if (sortBy === 'createTime') return w.createTime || 0;
      if (sortBy === 'playCount') return w.playCount || 0;
      if (sortBy === 'diggDensity') {
        // 点赞密度 = 点赞数 / 发布天数（发布越近、点赞越多，分越高）
        const days = Math.max(1, (Date.now() / 1000 - (w.createTime || 0)) / 86400);
        return (w.diggCount || 0) / days;
      }
      return w.diggCount || 0;
    };
    list.sort((a, b) => {
      const diff = getSortVal(a) - getSortVal(b);
      return sortDir === 'desc' ? -diff : diff;
    });
    return list;
  }, [allWorks, minDigg, maxDigg, minPlay, maxPlay, dateFrom, dateTo, publishDays, growthPeriod, minGrowth, onlyHot, sortBy, sortDir]);

  // 重置筛选
  const resetFilters = () => {
    setMinDigg(''); setMaxDigg('');
    setMinPlay(''); setMaxPlay('');
    setDateFrom(''); setDateTo('');
    setPublishDays('');
    setMinGrowth('');
  };

  // 发布至今快捷选择：选了天数就清空日期范围（两者互斥）
  const handlePublishDays = (days) => {
    setPublishDays(days);
    setDateFrom('');
    setDateTo('');
  };
  // 手动改日期范围时清空发布至今天数（互斥）
  const handleDateFromChange = (v) => {
    setDateFrom(v);
    if (v) setPublishDays('');
  };
  const handleDateToChange = (v) => {
    setDateTo(v);
    if (v) setPublishDays('');
  };

  // 导出 Excel（CSV + BOM）
  const handleExport = () => {
    if (filteredWorks.length === 0) return;
    const now = Date.now() / 1000;
    const data = filteredWorks.map(w => {
      const g = w[growthPeriod + 'Growth'] || {};
      const days = Math.max(1, (now - (w.createTime || 0)) / 86400);
      return {
        aweme_id: w.awemeId,
        desc: w.desc,
        author: w.authorName,
        hot_score: w.hotScore || 0,
        hot_level: w.hotLevel === 'hot' ? '爆款' : (w.hotLevel === 'potential' ? '潜力' : '普通'),
        digg_count: w.diggCount || 0,
        digg_density: ((w.diggCount || 0) / days).toFixed(1),
        comment_count: w.commentCount || 0,
        play_count: w.playCount || 0,
        share_count: w.shareCount || 0,
        collect_count: w.collectCount || 0,
        digg_growth: g.diggDelta || 0,
        growth_percent: (g.diggPercent || 0).toFixed(1) + '%',
        create_time: new Date((w.createTime || 0) * 1000).toLocaleString('zh-CN'),
        url: `https://www.douyin.com/video/${w.awemeId}`,
      };
    });
    const csv = arrayToCSV(data, [
      { key: 'aweme_id', label: '视频ID' },
      { key: 'desc', label: '标题' },
      { key: 'author', label: '作者' },
      { key: 'hot_score', label: '爆款指数' },
      { key: 'hot_level', label: '爆款分级' },
      { key: 'digg_count', label: '点赞数' },
      { key: 'digg_density', label: '点赞密度(赞/天)' },
      { key: 'comment_count', label: '评论数' },
      { key: 'play_count', label: '播放数' },
      { key: 'share_count', label: '分享数' },
      { key: 'collect_count', label: '收藏数' },
      { key: 'digg_growth', label: '点赞增长' },
      { key: 'growth_percent', label: '增长率' },
      { key: 'create_time', label: '发布时间' },
      { key: 'url', label: '链接' },
    ]);
    const safeName = (groupName || '分组').replace(/[\\/:*?"<>|]/g, '_');
    downloadCSV(csv, `爆款分析_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`);
  };

  // 复制筛选后视频链接（一行一个）
  const handleCopyLinks = async () => {
    if (filteredWorks.length === 0) return;
    const links = filteredWorks.map(w => `https://www.douyin.com/video/${w.awemeId}`).join('\n');
    try {
      await navigator.clipboard.writeText(links);
      setCopyTip(`已复制 ${filteredWorks.length} 条链接`);
    } catch {
      setCopyTip('复制失败，请重试');
    }
    setTimeout(() => setCopyTip(''), 2000);
  };

  const openExternal = (awemeId) => {
    window.electronAPI.openExternalUrl(`https://www.douyin.com/video/${awemeId}`);
  };

  return (
    <div className="hvam-overlay" onClick={onClose}>
      <div className="hvam-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="hvam-head">
          <div className="hvam-title">
            <div className="hvam-title-icon">
              <Flame size={20} />
            </div>
            <div>
              <h3>爆款分析 · {groupName}</h3>
              <p>共 {accounts.length} 个账号 · {allWorks.length} 条作品</p>
            </div>
          </div>
          <button className="hvam-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="hvam-loading">
            <span className="loading-spinner"></span>
            正在加载 {accounts.length} 个账号的作品数据...
          </div>
        ) : allWorks.length === 0 ? (
          <div className="hvam-empty">
            <BarChart3 size={48} />
            <div className="hvam-empty-title">该分组暂无作品数据</div>
            <div className="hvam-empty-text">需先在「运营监控」中拉取这些账号的作品</div>
          </div>
        ) : (
          <>
            {/* 工具栏：筛选条件 */}
            <div className="hvam-toolbar">
              <div className="hvam-filter-row">
                <span className="hvam-filter-label">点赞范围</span>
                <input
                  className="hvam-input"
                  type="number"
                  placeholder="最小"
                  value={minDigg}
                  onChange={(e) => setMinDigg(e.target.value)}
                />
                <span className="hvam-tilde">~</span>
                <input
                  className="hvam-input"
                  type="number"
                  placeholder="最大"
                  value={maxDigg}
                  onChange={(e) => setMaxDigg(e.target.value)}
                />
              </div>
              <div className="hvam-filter-row">
                <span className="hvam-filter-label">播放范围</span>
                <input
                  className="hvam-input"
                  type="number"
                  placeholder="最小"
                  value={minPlay}
                  onChange={(e) => setMinPlay(e.target.value)}
                />
                <span className="hvam-tilde">~</span>
                <input
                  className="hvam-input"
                  type="number"
                  placeholder="最大"
                  value={maxPlay}
                  onChange={(e) => setMaxPlay(e.target.value)}
                />
              </div>
              <div className="hvam-filter-row">
                <span className="hvam-filter-label">发布至今</span>
                <button
                  className={`hvam-chip${publishDays === '7' ? ' active' : ''}`}
                  onClick={() => handlePublishDays(publishDays === '7' ? '' : '7')}
                >
                  近7天
                </button>
                <button
                  className={`hvam-chip${publishDays === '15' ? ' active' : ''}`}
                  onClick={() => handlePublishDays(publishDays === '15' ? '' : '15')}
                >
                  近15天
                </button>
                <button
                  className={`hvam-chip${publishDays === '30' ? ' active' : ''}`}
                  onClick={() => handlePublishDays(publishDays === '30' ? '' : '30')}
                >
                  近30天
                </button>
                <span className="hvam-tilde">或自定义</span>
                <input
                  className="hvam-input hvam-input-sm"
                  type="number"
                  min="1"
                  placeholder="天数"
                  value={publishDays}
                  onChange={(e) => handlePublishDays(e.target.value)}
                />
                <span className="hvam-tilde">天</span>
              </div>
              <div className="hvam-filter-row">
                <span className="hvam-filter-label">发布时间</span>
                <input
                  className="hvam-input"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => handleDateFromChange(e.target.value)}
                />
                <span className="hvam-tilde">~</span>
                <input
                  className="hvam-input"
                  type="date"
                  value={dateTo}
                  onChange={(e) => handleDateToChange(e.target.value)}
                />
              </div>
              <div className="hvam-filter-row">
                <span className="hvam-filter-label">点赞增长</span>
                <select
                  className="hvam-input hvam-select"
                  value={growthPeriod}
                  onChange={(e) => setGrowthPeriod(e.target.value)}
                  title="增长统计周期"
                >
                  <option value="day">近24小时</option>
                  <option value="week">近7天</option>
                  <option value="month">近30天</option>
                  <option value="total">总计</option>
                </select>
                <span className="hvam-tilde">≥</span>
                <input
                  className="hvam-input"
                  type="number"
                  placeholder="最小增长值"
                  value={minGrowth}
                  onChange={(e) => setMinGrowth(e.target.value)}
                />
              </div>

              <div className="hvam-actions">
                <span className="hvam-count">
                  筛选结果：<strong>{filteredWorks.length}</strong> / {allWorks.length} 条
                  <span className="hvam-hot-stat">
                    （🔥爆款 {allWorks.filter(w => w.hotLevel === 'hot').length}
                    · 潜力 {allWorks.filter(w => w.hotLevel === 'potential').length}）
                  </span>
                </span>
                <label className={`hvam-toggle${onlyHot ? ' active' : ''}`} title="只显示爆款指数≥50的视频">
                  <input
                    type="checkbox"
                    checked={onlyHot}
                    onChange={(e) => setOnlyHot(e.target.checked)}
                  />
                  <Flame size={13} />
                  仅看爆款
                </label>
                <button className="hvam-btn hvam-btn-ghost" onClick={resetFilters} title="清空所有筛选条件">
                  重置
                </button>
                <button
                  className="hvam-btn hvam-btn-primary"
                  onClick={handleExport}
                  disabled={filteredWorks.length === 0}
                >
                  <Download size={15} />
                  导出 Excel
                </button>
                <button
                  className="hvam-btn hvam-btn-primary"
                  onClick={handleCopyLinks}
                  disabled={filteredWorks.length === 0}
                >
                  <Link2 size={15} />
                  复制链接
                </button>
                {copyTip && <span className="hvam-copytip">{copyTip}</span>}
              </div>
            </div>

            {/* 排序条 */}
            <div className="hvam-sortbar">
              <span className="hvam-sort-label">
                <BarChart3 size={14} />
                排序：
              </span>
              <select
                className="hvam-input hvam-select hvam-sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="hotScore">爆款指数（综合评分）</option>
                <option value="diggDensity">点赞密度（发布时间内赞最多）</option>
                <option value="diggCount">点赞数</option>
                <option value="diggGrowth">点赞增长（{PERIOD_LABEL[growthPeriod]}）</option>
                <option value="playCount">播放量</option>
                <option value="createTime">发布时间</option>
              </select>
              <button
                className="hvam-sort-dir"
                onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                title={sortDir === 'desc' ? '当前：降序，点击切换' : '当前：升序，点击切换'}
              >
                {sortDir === 'desc' ? '↓ 降序' : '↑ 升序'}
              </button>
            </div>

            {/* 作品列表 */}
            <div className="hvam-body">
              {filteredWorks.length === 0 ? (
                <div className="hvam-empty hvam-empty-sm">
                  <BarChart3 size={40} />
                  <div className="hvam-empty-title">当前筛选条件下无匹配作品</div>
                  <div className="hvam-empty-text">请调整筛选条件或点击「重置」</div>
                </div>
              ) : (
                <div className="hvam-list">
                  {filteredWorks.map(w => {
                    const g = w[growthPeriod + 'Growth'] || {};
                    const growthDelta = g.diggDelta || 0;
                    const growthPct = g.diggPercent || 0;
                    return (
                      <div key={w.awemeId} className="hvam-work-row">
                        <div className="hvam-work-cover">
                          {w.cover ? (
                            <img src={w.cover} alt="" loading="lazy" />
                          ) : (
                            <div className="hvam-cover-placeholder"><Film size={20} /></div>
                          )}
                        </div>
                        <div className="hvam-work-info">
                          <div className="hvam-work-title-wrap">
                            {w.hotLevel !== 'normal' && (
                              <span className={`hvam-hot-tag ${w.hotLevel}`} title={`爆款指数 ${w.hotScore}`}>
                                {w.hotLevel === 'hot' ? '🔥 爆款' : '⭐ 潜力'}
                              </span>
                            )}
                            <div
                              className="hvam-work-title"
                              onClick={() => openExternal(w.awemeId)}
                              title="点击在浏览器打开"
                            >
                              {w.desc || '(无标题)'}
                              <ExternalLink size={12} />
                            </div>
                          </div>
                          <div className="hvam-work-author">
                            {w.authorAvatar ? (
                              <img src={w.authorAvatar} alt="" className="hvam-author-avatar" />
                            ) : null}
                            <span>{w.authorName}</span>
                            <span className="hvam-work-date">· {fmtDate(w.createTime)}</span>
                          </div>
                        </div>
                        <div className="hvam-work-stats">
                          <span className="hvam-stat" title="点赞数">
                            <Heart size={13} />
                            {fmt(w.diggCount)}
                          </span>
                          <span className="hvam-stat" title="评论数">
                            <MessageSquare size={13} />
                            {fmt(w.commentCount)}
                          </span>
                          <span className="hvam-stat" title="播放量">
                            <Play size={13} />
                            {fmt(w.playCount)}
                          </span>
                          <span className="hvam-stat" title="分享数">
                            <Share2 size={13} />
                            {fmt(w.shareCount)}
                          </span>
                          <span className="hvam-stat" title="收藏数">
                            <Bookmark size={13} />
                            {fmt(w.collectCount)}
                          </span>
                        </div>
                        <div className="hvam-work-growth" title="综合点赞密度/互动率/绝对热度的爆款指数">
                          <span className="hvam-growth-label">爆款指数</span>
                          <span className={`hvam-growth-val${w.hotLevel === 'hot' ? ' up' : (w.hotLevel === 'potential' ? ' warm' : '')}`}>
                            {w.hotScore || 0}
                          </span>
                          <span className="hvam-growth-pct">{PERIOD_LABEL[growthPeriod]}赞 +{fmt(growthDelta)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default HotVideoAnalysisModal;
