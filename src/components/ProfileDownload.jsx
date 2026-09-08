import React, { useState, useEffect } from 'react';
import api from '../utils/api';
import { isImageWork, buildImageWorkItems, extractQualityOptions, pickQualityUrl } from '../utils/douyinWork';
import { exportVideosToXlsx } from '../utils/xlsxExport';
import './ProfileDownload.css';

// 净化文件夹名称（移除非法字符、结尾的点和空格，限制长度）
function sanitizeFolderName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\n\r\t]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 100);
}

/**
 * 规范化抖音分页响应中的 has_more 字段
 * 兼容：数字 1 / 布尔 true / 字符串 "1" / "true"
 * has_more 缺失时，若本页接近满页且游标发生变化（抖音 max_cursor 是时间戳，倒序翻页时会递减，只要变化即视为前进），则保守地认为可能还有更多
 */
function normalizeHasMore(rawHasMore, listLen, nextCursor, currentCursor, count) {
  if (rawHasMore === 1 || rawHasMore === true) return true;
  if (rawHasMore === '1' || rawHasMore === 'true') return true;
  if (rawHasMore === 0 || rawHasMore === false || rawHasMore === '0' || rawHasMore === 'false') return false;
  // has_more 缺失（undefined/null）：用游标变化 + 接近满页来判断
  const advanced = Number(nextCursor) !== Number(currentCursor);
  return listLen >= (count - 2) && advanced;
}

function ProfileDownload({ pythonRunning = false, onNavigate }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [userInfo, setUserInfo] = useState(null);
  const [videos, setVideos] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [downloadType, setDownloadType] = useState('post'); // post | collection | mix | search | like
  const [platformTab, setPlatformTab] = useState('douyin'); // 平台切换：douyin | tiktok | youtube
  const [youtubeLoading, setYoutubeLoading] = useState(false); // YouTube Shorts 抓取中
  const [youtubeProgress, setYoutubeProgress] = useState({ page: 0, fetched: 0 }); // 抓取进度
  const [likedStage, setLikedStage] = useState('fetch'); // 喜欢列表阶段：scroll(滚动捕获) | fetch(重放取数)
  const [fetchProgress, setFetchProgress] = useState({ current: 0, total: 0 });
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [maxPages, setMaxPages] = useState(10); // 默认10页
  const [selectedQuality, setSelectedQuality] = useState('auto'); // 抖音批量默认清晰度
  // 抓取结果的状态提示：{ type, message }，type: 'partial' | 'pageLimit' | null
  const [fetchNotice, setFetchNotice] = useState(null);
  // 主页下载历史记录
  const [history, setHistory] = useState([]);
  // 合集下载：合集列表选择弹窗
  const [mixModal, setMixModal] = useState(false);       // 是否显示合集选择弹窗
  const [mixes, setMixes] = useState([]);                // 聚合出的合集列表 [{mixId, mixName, count, cover}]
  const [mixLoading, setMixLoading] = useState(false);   // 正在拉取合集列表
  const [mixSecUserId, setMixSecUserId] = useState('');  // 当前解析出的用户ID（供合集下载用）
  const [mixVideoId, setMixVideoId] = useState('');      // 输入是视频链接时记录的作品ID（弹窗里可直接下载该视频）

  // 加载历史记录列表
  const loadHistory = async () => {
    try {
      const res = await window.electronAPI.profileHistoryList();
      if (res && res.success) setHistory(res.history || []);
    } catch (e) {
      console.error('加载主页下载历史失败:', e);
    }
  };

  // 挂载时加载历史记录
  useEffect(() => { loadHistory(); }, []);

  // 保存/更新一条历史记录（抓取成功后调用）
  // ctx: { secUserId, userInfo, videos, platform, downloadType, sourceUrl }
  const saveHistory = async (ctx) => {
    try {
      const u = ctx.userInfo || {};
      // 兼容两种 userInfo 结构：抖音接口 user 对象可能内嵌 user 字段，也可能平铺
      const nickname = u.nickname || u.user?.nickname || '';
      const avatar = u.avatar_thumb?.url_list?.[0] || u.user?.avatar_thumb?.url_list?.[0] || '';
      const uniqueId = u.unique_id || u.short_id || u.user?.unique_id || u.user?.short_id || '';
      // 去重 key：收藏作品用 sec_user_id:collection 区分，合集用 sec_user_id:mix 区分，发布作品用 sec_user_id
      let key = ctx.secUserId;
      if (ctx.downloadType === 'collection' && !key.endsWith(':collection')) {
        key = `${key}:collection`;
      } else if (ctx.downloadType === 'mix' && !key.endsWith(':mix')) {
        key = `${key}:mix`;
      }
      await window.electronAPI.profileHistoryAdd({
        secUserId: key,
        nickname,
        avatar,
        uniqueId,
        videos: ctx.videos,
        videoCount: ctx.videos.length,
        downloadType: ctx.downloadType || 'post',
        sourceUrl: ctx.sourceUrl || '',
        platform: ctx.platform || 'douyin',
      });
      await loadHistory();
    } catch (e) {
      console.error('保存主页下载历史失败:', e);
    }
  };

  // 切换平台（抖音 / TikTok / YouTube / 快手 / 哔哩哔哩）：重置输入与结果状态；
  // TikTok 仅发布作品，YouTube 仅 Shorts，快手/哔哩哔哩仅发布作品
  const switchPlatform = (p) => {
    if (p === platformTab) return;
    setPlatformTab(p);
    setUrl('');
    setVideos([]);
    setSelectedVideos(new Set());
    setError(null);
    setUserInfo(null);
    setFetchNotice(null);
    setFetchProgress({ current: 0, total: 0 });
    setShowModal(false);
    setMixModal(false);
    setDownloadType('post'); // TikTok/YouTube/快手/哔哩哔哩仅发布/Shorts；切回抖音默认发布
  };

  // 解析用户主页
  const handleFetchProfile = async ({
    platform = platformTab,
    downloadType: requestedDownloadType = downloadType,
    input = url,
  } = {}) => {
    const inputUrl = String(input || '').trim();

    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }

    if (!inputUrl) {
      setError('请输入有效的用户主页链接或ID');
      return;
    }

    // 合集下载模式：输入用户主页链接，解析出该用户的全部合集
    if (requestedDownloadType === 'mix') {
      return await handleOpenMixModal(inputUrl);
    }

    // 搜索下载模式：输入关键词搜索抖音视频
    if (requestedDownloadType === 'search') {
      return await handleSearch(inputUrl);
    }

    // 用户喜欢：输入用户主页喜欢页链接（showTab=like）
    if (requestedDownloadType === 'like') {
      return await handleLike(inputUrl);
    }

    // YouTube Shorts：输入频道主页地址抓取全部 Shorts
    if (platform === 'youtube') {
      return await handleYoutubeShorts(inputUrl);
    }

    // 快手主页：纯 HTTP 逆向 GraphQL，需先登录快手；仅支持发布作品
    if (platform === 'kuaishou') {
      return await handleKsProfile(inputUrl);
    }

    // 哔哩哔哩主页：纯 HTTP + Wbi 签名，无需登录；仅支持发布作品
    if (platform === 'bilibili') {
      return await handleBiliProfile(inputUrl);
    }

    setLoading(true);
    setError(null);
    setUserInfo(null);
    setVideos([]);
    setFetchNotice(null);
    setSelectedQuality('auto'); // 新一轮抓取，重置默认清晰度

    try {
      const trimmed = inputUrl;

      // 防御：检测其他平台主页链接，明确提示避免误操作（本页只支持抖音/TikTok/快手/B站主页）
      // 之前把小红书主页链接贴进来会被当 sec_user_id 传给抖音接口，报"UserId不合法"，
      // 页面上容易误以为显示了错误内容，这里直接拦截并指路。
      // 注意：快手主页在上方 handleKsProfile 分支已处理，不会走到这里。
      const otherPlatform = /xiaohongshu\.com|weibo\.com|acfun\.cn|pipix\.com|izuiyou\.com|v\.qq\.com|ixigua\.com/i.test(trimmed);
      if (otherPlatform) {
        setError('检测到这是其他平台的主页链接。「主页下载」仅支持抖音 / TikTok / 快手 / 哔哩哔哩主页。小红书主页请用侧边栏的「小红书主页」；其他平台请用首页的多平台解析。');
        return;
      }

      // TikTok 主页：官方接口受 WAF 拦截，走 tiktok 平台（主进程用 tikwm 解析目标用户）
      // 判定：平台 tab 选了 TikTok，或链接含 tiktok.com / 以 @用户名 开头（抖音用 sec_user_id / douyin.com，不会是 @）
      const isTiktok = platform === 'tiktok' ||
        /tiktok\.com/i.test(trimmed) ||
        (/^@[A-Za-z0-9._]+$/.test(trimmed) && !/douyin/i.test(trimmed));

      if (isTiktok) {
        // 1. 获取目标用户信息（uniqueId 由主进程从链接/@用户名中提取）
        const profileResult = await window.electronAPI.nativeAPI('tiktok', 'getUserProfile', { uniqueId: trimmed });
        if (!profileResult || !profileResult.success) {
          throw new Error((profileResult && profileResult.error) || '获取 TikTok 用户信息失败');
        }
        const profileData = profileResult.data;
        if (!profileData || !profileData.user) {
          throw new Error('获取 TikTok 用户信息失败，请检查链接是否正确');
        }
        setUserInfo(profileData.user);

        // 2. 获取目标用户作品列表（tiktok 平台，走 tikwm）
        await fetchUserVideos(trimmed, 'tiktok', profileData.user, 'post', inputUrl);
        return;
      }

      // ===== 抖音：与便携版一致，走 douyin API =====
      // 1. 解析链接获取 sec_user_id
      let secUserId = null;

      // 如果是完整链接，先解析
      if (trimmed.includes('douyin.com') || trimmed.includes('v.douyin.com')) {
        // 先尝试从原始URL中提取
        const directMatch = trimmed.match(/user\/([^?&/]+)/);
        if (directMatch) {
          secUserId = directMatch[1];
          console.log('从原始URL提取到 sec_user_id:', secUserId);
        } else {
          // 如果原始URL中没有，尝试解析短链接
          try {
            const resolved = await api.resolveShareLink(trimmed);
            console.log('解析后的链接:', resolved);

            // 从解析后的 URL 中提取 sec_user_id
            if (resolved && typeof resolved === 'string') {
              const match = resolved.match(/user\/([^?&/]+)/);
              if (match) {
                secUserId = match[1];
                console.log('从解析后URL提取到 sec_user_id:', secUserId);
              }
            }
          } catch (err) {
            console.warn('链接解析失败:', err);
          }
        }
      } else {
        // 直接输入的可能是 sec_user_id
        secUserId = trimmed;
      }

      if (!secUserId) {
        throw new Error('无法从链接中提取用户ID，请检查链接格式');
      }

      console.log('最终使用的 sec_user_id:', secUserId);

      // 2. 获取用户信息
      const profileData = await api.getUserProfile(secUserId);
      console.log('用户信息:', profileData);

      if (!profileData || !profileData.user) {
        throw new Error('获取用户信息失败，请检查链接是否正确或登录状态');
      }

      setUserInfo(profileData.user);

      // 3. 获取作品列表
      await fetchUserVideos(secUserId, 'douyin', profileData.user, requestedDownloadType, inputUrl);

    } catch (err) {
      console.error('获取失败:', err);
      setError(err.message || '获取失败');
    } finally {
      setLoading(false);
    }
  };

  // 获取用户作品（platform: 'douyin' | 'tiktok'）
  // userInfoArg: 调用方传入刚拿到的 userInfo（避免 state 异步未更新），用于保存历史记录
  const fetchUserVideos = async (
    secUserId,
    platform = 'douyin',
    userInfoArg = null,
    requestedDownloadType = downloadType,
    sourceInput = url,
  ) => {
    setFetchProgress({ current: 0, total: 0 });
    setFetchNotice(null);

    try {
      const allVideos = [];
      const seenIds = new Set(); // 按 aweme_id 去重，避免重复计入
      let cursor = 0;
      let hasMore = true;
      let pageCount = 0;
      // 停止原因：'hasMoreFalse' | 'cursorStall' | 'pageLimit' | 'noData' | 'emptyStall' | 'noNewStall' | 'allDone'
      let stopReason = 'allDone';
      const requestCount = platform === 'tiktok' ? 30 : 20;
      // 抖音对部分账号会返回“空页但 has_more=1 且游标变化”，需容忍连续空页后停止。
      // 实测某 1037 条账号在翻页过程中有多段 1~5 个连续空页，跨过后仍能继续出数据，
      // 真正的终止信号是 has_more=0。因此容忍上限设大一些（15），避免误停在中间空页段。
      let consecutiveEmpty = 0;
      const MAX_CONSECUTIVE_EMPTY = 15;
      // 接口从头循环返回重复数据时的保护：连续若干页无新增作品即停止
      let noNewStreak = 0;
      const MAX_NO_NEW = 3;

      while (hasMore && pageCount < maxPages) { // 使用用户设置的最大页数
        pageCount++;
        setFetchProgress({ current: pageCount, total: pageCount });

        let result;
        if (platform === 'tiktok') {
          // TikTok：走 tikwm（主进程），仅支持发布作品；cursor 为时间戳游标
          const r = await window.electronAPI.nativeAPI('tiktok', 'getUserVideos', {
            uniqueId: secUserId,
            cursor,
            count: 30,
          });
          if (!r || !r.success) {
            throw new Error((r && r.error) || '获取 TikTok 作品列表失败');
          }
          result = r.data;
        } else if (requestedDownloadType === 'post') {
          result = await api.getUserVideos(secUserId, cursor, requestCount);
        } else if (requestedDownloadType === 'collection') {
          result = await api.getUserCollections(secUserId, cursor, requestCount);
        }

        console.log(`第${pageCount}页数据:`, JSON.stringify(result).substring(0, 1000));

        // 处理不同的API响应结构
        let videoList = null;
        let nextCursor = 0;
        let rawHasMore;

        if (result) {
          console.log('返回的字段:', Object.keys(result));

          // 尝试多种可能的数据结构
          if (result.aweme_list && Array.isArray(result.aweme_list)) {
            videoList = result.aweme_list;
            nextCursor = result.max_cursor || 0;
            rawHasMore = result.has_more;
          } else if (result.data && result.data.aweme_list && Array.isArray(result.data.aweme_list)) {
            videoList = result.data.aweme_list;
            nextCursor = result.data.max_cursor || 0;
            rawHasMore = result.data.has_more;
          } else if (result.collect_list && Array.isArray(result.collect_list)) {
            // 收藏列表可能使用不同字段名
            videoList = result.collect_list;
            nextCursor = result.cursor || 0;
            rawHasMore = result.has_more;
          }
        }

        if (!videoList || videoList.length === 0) {
          if (pageCount === 1) {
            // 第一页就没有数据，可能是隐私设置问题
            let errorMsg = '获取作品列表失败';
            if (requestedDownloadType === 'collection') {
              errorMsg = '无法获取收藏列表，可能该用户的收藏列表已设为私密';
            } else {
              errorMsg = '该用户没有发布任何作品';
            }
            throw new Error(errorMsg);
          }
          // 非首页空页：抖音对部分账号会返回“空列表 + has_more=1 + 新游标”，
          // 此处容忍连续若干空页继续翻，超过上限才停止，避免被接口的假“还有更多”卡住。
          const prevCursorForEmpty = Number(cursor) || 0;
          const nextCursorForEmpty = Number(nextCursor) || 0;
          consecutiveEmpty++;
          console.log(`[ProfileDownload] 第${pageCount}页为空(连续第${consecutiveEmpty}次) has_more=${rawHasMore} cursor ${prevCursorForEmpty} -> ${nextCursorForEmpty}`);
          if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY || nextCursorForEmpty === prevCursorForEmpty) {
            stopReason = 'emptyStall';
            hasMore = false;
            break;
          }
          // 用新游标继续尝试下一页
          cursor = nextCursorForEmpty;
          // 注意：不更新 hasMore，让循环依据本次 rawHasMore 继续（空页时通常 has_more=1）
          hasMore = normalizeHasMore(rawHasMore, 0, nextCursorForEmpty, prevCursorForEmpty, requestCount);
          continue;
        }

        // 本页有数据，清空连续空页计数
        consecutiveEmpty = 0;

        // 按 aweme_id 去重后追加
        let addedThisPage = 0;
        for (const v of videoList) {
          const id = v && (v.aweme_id || v.id);
          if (id && seenIds.has(id)) continue;
          if (id) seenIds.add(id);
          allVideos.push(v);
          addedThisPage++;
        }

        // 接口可能从头循环返回重复数据（cursor 回到 0 且数据全是已见），
        // 连续若干页都没有新增任何作品时停止，避免死循环。
        if (addedThisPage === 0) {
          noNewStreak++;
          console.log(`[ProfileDownload] 第${pageCount}页无新增作品(连续第${noNewStreak}次)`);
          if (noNewStreak >= MAX_NO_NEW) {
            stopReason = 'noNewStall';
            hasMore = false;
            break;
          }
        } else {
          noNewStreak = 0;
        }

        // 游标前进检测：非首页时游标未变化，判定为分页被截断，停止避免死循环
        // 注意：抖音 max_cursor 是时间戳，作品按时间倒序，翻到更早作品时 cursor 会递减，
        // 因此只要 cursor 发生变化（无论变大变小）都视为正常前进；只有“完全不变”才停止。
        const prevCursor = Number(cursor) || 0;
        const nextCursorNum = Number(nextCursor) || 0;
        if (pageCount > 1 && nextCursorNum === prevCursor) {
          stopReason = 'cursorStall';
          hasMore = false;
          break;
        }

        // 诊断日志：第一页打印原始分页字段，便于定位“只拿到 18 条”类问题
        if (pageCount === 1) {
          console.log('[ProfileDownload] 第1页分页字段:', {
            rawHasMore,
            hasMoreType: typeof rawHasMore,
            nextCursor,
            prevCursor,
            listLen: videoList.length,
            requestCount,
            totalAwemeCount: userInfo && userInfo.user && userInfo.user.aweme_count,
          });
        }

        hasMore = normalizeHasMore(rawHasMore, videoList.length, nextCursorNum, prevCursor, requestCount);
        cursor = nextCursorNum;
        if (!hasMore) {
          stopReason = 'hasMoreFalse';
        }
      }

      // 达到页数上限：标记为页数上限停止
      if (hasMore && pageCount >= maxPages) {
        stopReason = 'pageLimit';
      }

      // 生成部分结果提示
      const totalAwemeCount = userInfo && userInfo.user && userInfo.user.aweme_count;
      if (typeof totalAwemeCount === 'number' && totalAwemeCount > allVideos.length) {
        if (stopReason === 'hasMoreFalse') {
          // 接口 has_more=0 正常结束：少的是私密/仅粉丝可见作品（只有作者本人登录才能看到），不是抓取问题
          setFetchNotice({
            type: 'limit',
            message: `该账号共发布 ${totalAwemeCount} 个作品，接口返回 ${allVideos.length} 个可见作品，其余为私密或对非粉丝隐藏的作品（用作者本人的抖音账号登录后可获取全部）。`,
          });
        } else if (stopReason === 'cursorStall' || stopReason === 'emptyStall') {
          const reason = stopReason === 'emptyStall'
            ? '抖音接口连续返回空页（仍声称有更多）'
            : '抖音风控、未登录或接口限制导致分页被截断';
          setFetchNotice({
            type: 'partial',
            message: `该账号共有 ${totalAwemeCount} 个作品，仅获取到 ${allVideos.length} 个。可能是${reason}。建议在设置中登录抖音账号后重试，或稍后再试。`,
          });
        }
      } else if (stopReason === 'pageLimit') {
        const hint = maxPages >= 999
          ? `已获取 ${allVideos.length} 个作品。`
          : `已获取 ${allVideos.length} 个作品，达到设定的页数上限（${maxPages} 页）。如需更多，请在上方“获取页数限制”中选择更大值或“全部获取”。`;
        if (typeof totalAwemeCount === 'number' && totalAwemeCount > allVideos.length) {
          setFetchNotice({ type: 'pageLimit', message: hint });
        }
      }

      setVideos(allVideos);
      setFetchProgress({ current: 0, total: 0 });

      // 默认全选
      const allIndices = allVideos.map((_, idx) => idx);
      setSelectedVideos(new Set(allIndices));
      setShowModal(true);

      // 保存到历史记录（按 sec_user_id 去重，重复抓取覆盖）
      if (userInfoArg) {
        await saveHistory({
          secUserId,
          userInfo: userInfoArg,
          videos: allVideos,
          platform,
          downloadType: requestedDownloadType,
          sourceUrl: String(sourceInput || '').trim(),
        });
      }

    } catch (err) {
      console.error('获取作品列表失败:', err);
      setError(err.message || '获取作品列表失败');
      setFetchProgress({ current: 0, total: 0 });
    }
  };

  // 切换选择
  const toggleVideoSelection = (index) => {
    const newSelected = new Set(selectedVideos);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedVideos(newSelected);
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedVideos.size === videos.length) {
      setSelectedVideos(new Set());
    } else {
      setSelectedVideos(new Set(videos.map((_, idx) => idx)));
    }
  };

  // 计算可选清晰度：
  //  - 哔哩哔哩：档位在抓取时按登录态生成（未登录最高 720P，登录后可选 1080P），
  //    下载时映射为 yt-dlp 的 height 限制（bestvideo[height<=N]+bestaudio）
  //  - 抖音：取所有视频 bit_rate 档位的交集（只显示"所有视频都支持"的档位，避免选了某档但部分视频没有而反复降级）
  const availableQualities = (() => {
    if (platformTab === 'bilibili') {
      const biliVideos = videos.filter(v => v && v.isBilibili);
      if (biliVideos.length === 0) return [];
      const perVideoSets = biliVideos.map(v => new Set((v.qualityOptions || []).map(q => q.value)));
      const common = (biliVideos[0].qualityOptions || []).filter(opt =>
        perVideoSets.every(s => s.has(opt.value))
      );
      return [{ label: '默认（最高）', value: 'auto' }, ...common];
    }
    const douyinVideos = videos.filter(v => v && !v.isTiktok && !v.isBilibili && !isImageWork(v));
    if (douyinVideos.length === 0) return [];
    const perVideoSets = douyinVideos.map(v => new Set(
      extractQualityOptions(v).map(q => q.value)
    ));
    const common = [...perVideoSets[0]].filter(val =>
      val !== 'auto' && perVideoSets.every(s => s.has(val))
    );
    const firstOpts = extractQualityOptions(douyinVideos[0]);
    const result = [{ label: '默认（最高）', value: 'auto' }];
    for (const val of common) {
      const opt = firstOpts.find(o => o.value === val);
      if (opt) result.push({ label: opt.label, value: opt.value });
    }
    return result;
  })();

  // 批量下载
  const handleBatchDownload = async () => {
    if (selectedVideos.size === 0) return;

    setBatchDownloading(true);

    try {
      let attemptedCount = 0;
      let acceptedCount = 0;
      let rejectedCount = 0;
      const submitTask = async (label, submit) => {
        attemptedCount += 1;
        try {
          const result = await submit();
          if (result?.success === false) throw new Error(result.error || '任务未能加入队列');
          acceptedCount += 1;
        } catch (error) {
          rejectedCount += 1;
          console.warn(`[ProfileDownload] ${label}提交失败:`, error?.message || error);
        }
      };

      const batchId = `profile_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      // 搜索下载：文件夹按关键词命名（结果跨多个作者）；其他模式按用户昵称命名
      const rawAuthor = downloadType === 'search'
        ? (url.trim() || '关键词')
        : (userInfo?.nickname || userInfo?.user?.nickname || (videos[0] && videos[0].author?.nickname) || '未知用户');
      const typeLabel = downloadType === 'collection' ? '收藏' : downloadType === 'mix' ? '合集' : downloadType === 'search' ? '搜索' : downloadType === 'like' ? '喜欢' : '主页';
      const folderName = `${sanitizeFolderName(rawAuthor)}--${typeLabel}`;
      const avatar = (userInfo?.avatar_thumb?.url_list?.[0]) || (userInfo?.user?.avatar_thumb?.url_list?.[0]) || '';
      const sourceUrl = (url || '').trim();

      const batchInfo = {
        nickname: folderName,
        authorName: rawAuthor,
        profileUrl: sourceUrl,
        avatar: avatar,
        platform: platformTab === 'youtube' ? 'youtube' : (platformTab === 'kuaishou' ? 'kuaishou' : (platformTab === 'bilibili' ? 'bilibili' : 'douyin')),
        folderName: folderName,
      };

      const options = {
        customDir: folderName,
        batchId: batchId,
        batchInfo: batchInfo,
      };

      for (const index of selectedVideos) {
        const video = videos[index];
        if (!video) continue;

        // YouTube Shorts：每条用 yt-dlp 下载（shorts 链接），最高画质
        if (video.isYoutube === true || platformTab === 'youtube') {
          const ytInfo = {
            desc: video.title || '',
            title: video.title || '',
            author: userInfo?.nickname || rawAuthor,
            awemeId: video.video_id,
            platform: 'youtube',
            platformName: 'YouTube',
            sourceUrl: video.watch_url || video.short_url || '',
          };
          const ytOptions = {
            ...options,
            batchInfo: { ...batchInfo, platform: 'youtube' },
          };
          const ytUrl = video.watch_url || video.short_url;
          if (!ytUrl) continue;
          // 传入 ytOptions（customDir 文件夹 + batchId/batchInfo 批次分组），
          // 与抖音主页下载一致：按「用户名--主页」文件夹存放、下载管理按批次分组显示
          await submitTask(video.title || 'YouTube Shorts', () =>
            window.electronAPI.downloadYtdl(ytUrl, ytInfo, 'youtube', 0, ytOptions));
          continue;
        }

        // B 站投稿视频：每条用 yt-dlp 下载（B 站 extractor 支持，未登录可下 720p，
        // 已登录哔哩哔哩（cookie_bilibili）时 yt-dlp 自动用 SESSDATA 下更高清晰度）
        if (video.isBilibili === true || platformTab === 'bilibili') {
          const biliInfo = {
            desc: video.title || '',
            title: video.title || '',
            author: video.author_name || video.author?.nickname || rawAuthor,
            awemeId: video.bvid,
            platform: 'bilibili',
            platformName: '哔哩哔哩',
            sourceUrl: video.watch_url || video.share_url || '',
          };
          const biliOptions = {
            ...options,
            batchInfo: { ...batchInfo, platform: 'bilibili' },
          };
          const biliUrl = video.watch_url || video.share_url;
          if (!biliUrl) continue;
          // 用户选择的清晰度 -> yt-dlp 最高高度限制（formatId=height；'auto'/未选时 0=最高不限制）
          const biliFormatId = selectedQuality && selectedQuality !== 'auto' ? Number(selectedQuality) : 0;
          await submitTask(video.title || '哔哩哔哩视频', () =>
            window.electronAPI.downloadYtdl(biliUrl, biliInfo, 'bilibili', biliFormatId, biliOptions));
          continue;
        }

        // 统一构造 videoInfo（按账号创建文件夹模式需要 author/platform）
        const isTiktok = video.isTiktok === true;
        const isKuaishou = video.platform === 'kuaishou';
        const curPlatform = isTiktok ? 'tiktok' : (isKuaishou ? 'kuaishou' : 'douyin');
        const videoInfo = {
          desc: video.desc,
          title: video.desc,                       // 图集下载用 title
          author: video.author?.nickname || rawAuthor,
          uid: video.author?.uid,
          create_time: video.create_time,
          awemeId: video.aweme_id,
          platform: curPlatform,
          // 作品页面链接：下载管理展示用，避免展示会过期的 CDN 直链/音频地址
          sourceUrl: video.tiktokShareUrl || video.share_url || '',
        };

        const itemOptions = {
          ...options,
          batchInfo: { ...batchInfo, platform: curPlatform },
        };

        // TikTok 视频：优先使用官方接口返回的 playAddr（无水印可播放直链）
        if (isTiktok) {
          // TikTok 图文作品
          if (Array.isArray(video.images) && video.images.length > 0) {
            const items = video.images
              .map((img, i) => ({
                url: img.url_list?.[0] || img.url || '',
                filename: `${(video.desc || 'tiktok_img').substring(0, 40)}_${i + 1}.jpg`,
              }))
              .filter(it => it.url);
            if (items.length === 0) continue;
            await submitTask(video.desc || 'TikTok 图集', () =>
              window.electronAPI.downloadAlbum(items, videoInfo, 'tiktok', itemOptions));
            continue;
          }

          // TikTok 视频：优先 playAddr，失败时回退到 tikwm 解析无水印直链
          let videoUrl = video.video?.play_addr?.url_list?.[0] || '';
          if (!videoUrl) {
            try {
              const parsed = await window.electronAPI.parseVideoLink(video.tiktokShareUrl);
              if (parsed && parsed.success && parsed.data?.video?.url) {
                videoUrl = parsed.data.video.url;
              }
            } catch (e) {
              console.warn('TikTok 视频解析失败:', e.message);
            }
          }
          if (!videoUrl) continue;
          const filename = `${video.desc?.substring(0, 50) || 'tiktok_video'}_${video.aweme_id || Date.now()}.mp4`
            .replace(/[<>:"/\\|?*\n\r]/g, '_');
          await submitTask(video.desc || 'TikTok 视频', () =>
            window.electronAPI.downloadFile(videoUrl, filename, videoInfo, 'tiktok', itemOptions));
          continue;
        }

        // 1) 图文作品（图集+背景音乐）：item.images 有图片，且没有真视频流
        //    注意：图文作品的 video.play_addr 实际是 BGM 音乐地址，不能当视频下载
        //    快手图集作品 normalizeFeed 已把 ext_params.atlas 映射到 images，复用此分支
        if (isImageWork(video)) {
          const items = buildImageWorkItems(video);
          if (items.length === 0) continue;
          await submitTask(video.desc || '图集', () =>
            window.electronAPI.downloadAlbum(items, videoInfo, curPlatform, itemOptions));
          continue;
        }

        // 2) 普通视频作品：按用户选择的清晰度取直链（找不到则降级用默认最高）
        //    快手作品 normalizeFeed 已把 photoUrl 映射到 video.play_addr.url_list[0]
        const videoUrl = pickQualityUrl(video, selectedQuality);

        if (!videoUrl) continue;

        // 生成文件名
        const filename = `${video.desc?.substring(0, 50) || (curPlatform + '_video')}_${video.aweme_id || Date.now()}.mp4`;
        const sanitizedFilename = filename.replace(/[<>:"/\\|?*\n\r]/g, '_');

        await submitTask(video.desc || '视频', () =>
          window.electronAPI.downloadFile(videoUrl, sanitizedFilename, videoInfo, curPlatform, itemOptions));
      }

      const skippedCount = Math.max(0, selectedVideos.size - attemptedCount);
      const failedCount = rejectedCount + skippedCount;
      if (acceptedCount === 0) {
        setError(failedCount > 0 ? '所选作品均未能加入下载队列，请检查链接后重试' : '没有可提交的作品');
        return;
      }

      setShowModal(false);
      setVideos([]);
      setSelectedVideos(new Set());

      console.log(`已添加 ${acceptedCount} 个下载任务到下载管理`);
      setError(failedCount > 0 ? `已添加 ${acceptedCount} 个任务，${failedCount} 个任务未能添加` : null);
      if (acceptedCount > 0 && typeof onNavigate === 'function') {
        onNavigate('download', 'downloading');
      }

    } catch (err) {
      console.error('批量下载失败:', err);
      setError(err.message || '批量下载失败');
    } finally {
      setBatchDownloading(false);
    }
  };

  // 关闭弹窗
  const closeModal = () => {
    setShowModal(false);
    setVideos([]);
    setSelectedVideos(new Set());
  };

  const handleExportVideos = async () => {
    try {
      setError(null);
      await exportVideosToXlsx(videos, userInfo?.user?.nickname || '');
    } catch (exportError) {
      console.error('导出 Excel 失败:', exportError);
      setError(exportError?.message || '导出 Excel 失败');
    }
  };

  // ===== 抖音搜索下载 =====

  // 搜索下载模式：主进程纯逆向搜索（签名捕获一次 + net.fetch 纯 HTTP 翻页），
  // 主进程逐页推送进度（douyin-search-progress），返回完整 aweme 列表（含直链）
  const handleSearch = async (overrideKeyword = null) => {
    const keyword = (typeof overrideKeyword === 'string' ? overrideKeyword.trim() : url.trim());

    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }
    if (!keyword) {
      setError('请输入搜索关键词，如：红烧肉');
      return;
    }

    setLoading(true);
    setError(null);
    setUserInfo(null);
    setVideos([]);
    setFetchNotice(null);
    setSelectedQuality('auto');
    setFetchProgress({ current: 0, total: 0 });

    // 订阅主进程逐页进度：显示「搜索中 第X/N页 · 已获取Y条」
    const unsubscribe = window.electronAPI.onSearchProgress((p) => {
      setFetchProgress({ current: p.page || 0, total: p.total || 0, fetched: p.fetched || 0 });
    });

    try {
      // 主进程：纯逆向搜索（签名捕获一次 + net.fetch 纯 HTTP 翻页），
      // 返回完整 aweme 列表（含视频直链），直接进批量下载弹窗
      const searchRes = await window.electronAPI.douyinSearch(keyword, maxPages);
      const videos = (searchRes && searchRes.success) ? (searchRes.videos || []) : [];
      if (!videos || videos.length === 0) {
        throw new Error((searchRes && searchRes.error) || '未搜索到相关视频，换个关键词试试');
      }

      setVideos(videos);
      setFetchProgress({ current: 0, total: 0 });
      // 默认全选
      setSelectedVideos(new Set(videos.map((_, idx) => idx)));
      setShowModal(true);

      // 保存到历史记录（按关键词去重，重复搜索覆盖）
      await saveHistory({
        secUserId: `search:${keyword}`,
        userInfo: { nickname: `“${keyword}” 搜索结果`, unique_id: '抖音搜索', avatar: '' },
        videos,
        platform: 'douyin',
        downloadType: 'search',
        sourceUrl: keyword,
      });

    } catch (err) {
      console.error('搜索失败:', err);
      setError(err.message || '搜索失败');
      setFetchProgress({ current: 0, total: 0 });
    } finally {
      unsubscribe();
      setLoading(false);
    }
  };

  // ===== 用户喜欢 =====

  // 用户喜欢列表（纯逆向：主进程滚动捕获签名 + net.fetch 重放），分页取数、进度显示
  const handleLike = async (overrideUrl = null) => {
    const inputUrl = (typeof overrideUrl === 'string' ? overrideUrl.trim() : url.trim());
    if (!inputUrl) {
      setError('请输入用户主页链接，如 https://www.douyin.com/user/xxx（会自动带上 showTab=like）');
      return;
    }
    if (!/douyin\.com\/user\//i.test(inputUrl)) {
      setError('请输入抖音用户主页链接，如 https://www.douyin.com/user/xxx（会自动带上 showTab=like）');
      return;
    }

    setLoading(true);
    setError(null);
    setUserInfo(null);
    setVideos([]);
    setFetchNotice(null);
    setFetchProgress({ current: 0, total: 0 });

    // 订阅主进程逐页进度：滚动捕获阶段（stage=scroll）与纯 HTTP 重放阶段（stage=fetch）
    const unsubscribe = window.electronAPI.onLikedProgress((p) => {
      setLikedStage(p.stage || 'fetch');
      setFetchProgress({ current: p.page || 0, total: p.total || 0, fetched: p.fetched || 0 });
    });

    try {
      const res = await window.electronAPI.douyinLiked(inputUrl, maxPages);
      const videos = (res && res.success) ? (res.videos || []) : [];
      if (!videos || videos.length === 0) {
        throw new Error((res && res.error) || '未获取到该用户的喜欢作品，可能是隐私设置或未公开');
      }

      setVideos(videos);
      setFetchProgress({ current: 0, total: 0 });
      setSelectedVideos(new Set(videos.map((_, idx) => idx)));
      setShowModal(true);
    } catch (err) {
      console.error('获取喜欢列表失败:', err);
      setError(err.message || '获取失败');
      setFetchProgress({ current: 0, total: 0 });
    } finally {
      unsubscribe();
      setLoading(false);
      setLikedStage('fetch');
    }
  };

  // ===== YouTube 频道 Shorts =====

  // ===== 快手主页 =====
  // 抓取快手用户主页发布作品（纯 HTTP 逆向 GraphQL，主进程 kuaishouProfile，需先登录快手）
  // 进度通过 onKsProfileProgress 逐页推送，结果进批量下载弹窗
  const handleKsProfile = async (overrideUrl = null) => {
    const inputUrl = (typeof overrideUrl === 'string' ? overrideUrl.trim() : url.trim());
    if (!inputUrl) {
      setError('请输入快手主页链接，如 https://www.kuaishou.com/profile/3x9bby984bftshc');
      return;
    }
    if (!/kuaishou\.com\/profile\//i.test(inputUrl) && !/^[A-Za-z0-9_-]{6,}$/.test(inputUrl)) {
      setError('请输入快手主页链接，如 https://www.kuaishou.com/profile/3x9bby984bftshc');
      return;
    }

    setLoading(true);
    setError(null);
    setUserInfo(null);
    setVideos([]);
    setFetchNotice(null);
    setFetchProgress({ current: 0, total: 0 });
    setSelectedQuality('auto');

    // 订阅主进程逐页进度
    const unsubscribe = window.electronAPI.onKsProfileProgress((p) => {
      setFetchProgress({ current: p.page || 0, total: p.total || 0, fetched: p.fetched || 0 });
    });

    try {
      const res = await window.electronAPI.ksProfileList(inputUrl, maxPages);
      const videos = (res && res.success) ? (res.videos || []) : [];
      if (!res || !res.success || videos.length === 0) {
        throw new Error((res && res.error) || '未获取到快手作品，请确认已登录快手且链接正确');
      }

      setUserInfo(res.user);
      setVideos(videos);
      setFetchProgress({ current: 0, total: 0 });
      // 默认全选
      setSelectedVideos(new Set(videos.map((_, idx) => idx)));
      setShowModal(true);

      // 保存到主页下载历史（按 userId 去重）
      await saveHistory({
        secUserId: res.user?.sec_user_id || inputUrl,
        userInfo: res.user,
        videos,
        platform: 'kuaishou',
        downloadType: 'post',
        sourceUrl: inputUrl,
      });
    } catch (err) {
      console.error('获取快手作品失败:', err);
      setError(err.message || '获取快手作品失败');
      setFetchProgress({ current: 0, total: 0 });
    } finally {
      unsubscribe();
      setLoading(false);
    }
  };

  // ===== 哔哩哔哩主页 =====
  // 抓取 B 站用户空间投稿作品（纯 HTTP + Wbi 签名，主进程 bilibiliProfile，无需登录）
  // 进度通过 onBiliProfileProgress 逐页推送，结果进批量下载弹窗
  const handleBiliProfile = async (overrideUrl = null) => {
    const inputUrl = (typeof overrideUrl === 'string' ? overrideUrl.trim() : url.trim());
    if (!inputUrl) {
      setError('请输入 B 站空间主页链接，如 https://space.bilibili.com/946974/video');
      return;
    }
    if (!/space\.bilibili\.com\/\d+/.test(inputUrl) && !/^\d{5,12}$/.test(inputUrl)) {
      setError('请输入 B 站空间主页链接（含用户 UID），如 https://space.bilibili.com/946974/video');
      return;
    }

    setLoading(true);
    setError(null);
    setUserInfo(null);
    setVideos([]);
    setFetchNotice(null);
    setFetchProgress({ current: 0, total: 0 });
    setSelectedQuality('auto');

    // 订阅主进程逐页进度
    const unsubscribe = window.electronAPI.onBiliProfileProgress((p) => {
      setFetchProgress({ current: p.page || 0, total: p.total || 0, fetched: p.fetched || 0 });
    });

    try {
      const res = await window.electronAPI.biliProfileList(inputUrl, maxPages);
      const videos = (res && res.success) ? (res.videos || []) : [];
      if (!res || !res.success || videos.length === 0) {
        throw new Error((res && res.error) || '未获取到该用户的投稿作品，请确认 UID 正确');
      }

      setUserInfo(res.user);
      setVideos(videos);
      setFetchProgress({ current: 0, total: 0 });
      // 默认全选
      setSelectedVideos(new Set(videos.map((_, idx) => idx)));
      setShowModal(true);

      // 保存到主页下载历史（按 mid 去重）
      await saveHistory({
        secUserId: res.user?.mid || inputUrl,
        userInfo: res.user,
        videos,
        platform: 'bilibili',
        downloadType: 'post',
        sourceUrl: inputUrl,
      });
    } catch (err) {
      console.error('获取哔哩哔哩作品失败:', err);
      setError(err.message || '获取哔哩哔哩作品失败');
      setFetchProgress({ current: 0, total: 0 });
    } finally {
      unsubscribe();
      setLoading(false);
    }
  };

  // 抓取频道全部 Shorts（纯 HTTP 逆向，主进程 youtubeShorts），结果进批量下载弹窗
  const handleYoutubeShorts = async (overrideUrl = null) => {
    const inputUrl = (typeof overrideUrl === 'string' ? overrideUrl.trim() : url.trim());
    if (!inputUrl) {
      setError('请输入 YouTube 频道主页地址，如 https://www.youtube.com/@iamfromkorea/shorts');
      return;
    }
    if (!/youtube\.com\/@/i.test(inputUrl)) {
      setError('请输入包含 @频道名的 YouTube 地址，如 https://www.youtube.com/@iamfromkorea');
      return;
    }

    setYoutubeLoading(true);
    setError(null);
    setUserInfo(null);
    setVideos([]);
    setFetchNotice(null);
    setYoutubeProgress({ page: 0, fetched: 0 });

    // 订阅主进程逐页进度：显示「已获取 N 条 · 第 P 页」
    const unsubscribe = window.electronAPI.onYoutubeShortsProgress((p) => {
      setYoutubeProgress({ page: p.page || 0, fetched: p.fetched || 0 });
    });

    try {
      const res = await window.electronAPI.youtubeShorts(inputUrl, maxPages);
      if (!res || !res.success || !Array.isArray(res.shorts) || res.shorts.length === 0) {
        throw new Error((res && res.error) || '未获取到该频道的 Shorts');
      }
      const shorts = res.shorts;

      setUserInfo({
        nickname: `@${res.handle || '频道'}`,
        unique_id: res.handle || '',
        user: { nickname: `@${res.handle || '频道'}`, unique_id: res.handle || '' },
      });
      setVideos(shorts);
      setSelectedVideos(new Set(shorts.map((_, idx) => idx)));
      setShowModal(true);
    } catch (err) {
      console.error('YouTube Shorts 抓取失败:', err);
      setError(err.message || '抓取失败');
    } finally {
      unsubscribe();
      setYoutubeLoading(false);
      setYoutubeProgress({ page: 0, fetched: 0 });
    }
  };

  // ===== 合集下载 =====

  // 从输入中提取视频/图集作品 ID（支持 /video/xxx、/note/xxx、modal_id=、纯数字）
  const extractVideoIdFromInput = (input) => {
    const s = (input || '').trim();
    if (!s) return null;
    const patterns = [
      /video\/(\d+)/,
      /note\/(\d+)/,
      /modal_id=(\d+)/,
      /slides\/(\d+)/,
    ];
    for (const p of patterns) {
      const m = s.match(p);
      if (m && m[1]) return m[1];
    }
    // 纯数字（19位抖音作品ID）
    if (/^\d{10,20}$/.test(s)) return s;
    return null;
  };

  // 解析当前输入框 URL 得到抖音 sec_user_id（与 handleFetchProfile 同逻辑，供合集下载复用）
  const resolveSecUserId = async (input) => {
    const trimmed = (input || '').trim();
    if (!trimmed) throw new Error('请先输入用户主页链接或 sec_user_id');
    // 其他平台直接拦截（合集只支持抖音）
    if (/xiaohongshu\.com|kuaishou\.com|bilibili\.com|b23\.tv|weibo\.com|youtube\.com|acfun\.cn/i.test(trimmed)) {
      throw new Error('合集下载仅支持抖音用户主页或视频链接');
    }
    // TikTok 不支持合集
    if (/tiktok\.com/i.test(trimmed) || (/^@[A-Za-z0-9._]+$/.test(trimmed) && !/douyin/i.test(trimmed))) {
      throw new Error('合集下载仅支持抖音用户主页或视频链接');
    }
    // 视频/图集链接：返回空（由调用方走 getVideoDetail 解析所属合集）
    if (extractVideoIdFromInput(trimmed)) return '';
    if (trimmed.includes('douyin.com') || trimmed.includes('v.douyin.com')) {
      const direct = trimmed.match(/user\/([^?&/]+)/);
      if (direct) return direct[1];
      try {
        const resolved = await api.resolveShareLink(trimmed);
        if (resolved && typeof resolved === 'string') {
          const m = resolved.match(/user\/([^?&/]+)/);
          if (m) return m[1];
        }
      } catch (e) { /* ignore */ }
    }
    // 直接输入的 sec_user_id
    return trimmed;
  };

  // 拉取目标用户全部作品，聚合出合集列表（作品列表每条都带 mix_info，无需单独的合集接口）
  const fetchMixList = async (secUserId, onProgress) => {
    const mixMap = new Map(); // mixId -> { mixId, mixName, count, cover, desc }
    const seenIds = new Set();
    let cursor = 0;
    let hasMore = true;
    let pageCount = 0;
    const requestCount = 20;
    let consecutiveEmpty = 0;
    let noNewStreak = 0;
    const MAX_CONSECUTIVE_EMPTY = 15;
    const MAX_NO_NEW = 3;
    const MAX_PAGES = 100; // 合集聚合最多翻 100 页（覆盖 2000 条作品）

    while (hasMore && pageCount < MAX_PAGES) {
      pageCount++;
      if (onProgress) onProgress(pageCount);
      let result;
      try {
        result = await api.getUserVideos(secUserId, cursor, requestCount);
      } catch (e) {
        if (pageCount === 1) throw e;
        break;
      }
      const list = (result && (result.aweme_list || (result.data && result.data.aweme_list))) || [];
      if (list.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY || Number(result.max_cursor || 0) === Number(cursor)) break;
        cursor = result.max_cursor || 0;
        hasMore = result.has_more !== undefined ? !!result.has_more : true;
        continue;
      }
      consecutiveEmpty = 0;
      let added = 0;
      for (const v of list) {
        const id = v && (v.aweme_id || v.id);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        added++;
        const mix = v && (v.mix_info || v.mix_aweme_info);
        if (mix && mix.mix_id) {
          if (!mixMap.has(mix.mix_id)) {
            mixMap.set(mix.mix_id, {
              mixId: mix.mix_id,
              mixName: mix.mix_name || mix.name || '未命名合集',
              count: 0,
              cover: (mix.cover_url && mix.cover_url.url_list && mix.cover_url.url_list[0]) || '',
              desc: mix.desc || '',
            });
          }
          const entry = mixMap.get(mix.mix_id);
          entry.count++;
        }
      }
      if (added === 0) {
        noNewStreak++;
        if (noNewStreak >= MAX_NO_NEW) break;
      } else {
        noNewStreak = 0;
      }
      const prevCursor = Number(cursor) || 0;
      const nextCursor = Number(result.max_cursor || 0) || 0;
      if (pageCount > 1 && nextCursor === prevCursor) break;
      cursor = nextCursor;
      hasMore = result.has_more !== undefined ? !!result.has_more : true;
      if (!hasMore) break;
    }
    // 按作品数降序排列，合集作品多的排前面
    return [...mixMap.values()].sort((a, b) => b.count - a.count);
  };

  // 点击「合集下载」：解析输入 → 打开合集选择弹窗
  // 支持两种输入：① 用户主页链接/sec_user_id（聚合该用户全部合集）
  //               ② 视频/图集链接（直接解析该作品所属的合集）
  const handleOpenMixModal = async (overrideUrl = null) => {
    const rawInput = typeof overrideUrl === 'string' ? overrideUrl.trim() : url.trim();
    if (!rawInput) {
      setError('请先在输入框中粘贴抖音用户主页链接或视频链接，再点「合集下载」解析合集');
      return;
    }
    setMixLoading(true);
    setError(null);
    setFetchNotice(null);
    try {
      const videoId = extractVideoIdFromInput(rawInput);
      if (videoId) {
        // 视频/图集链接：getVideoDetail 直接拿所属合集
        const detail = await api.getVideoDetail(videoId);
        const item = (detail && detail.aweme_detail) || {};
        const mix = item.mix_info || {};
        setMixVideoId(videoId); // 记录当前视频ID：弹窗里可直接下载该视频
        if (!mix.mix_id) {
          // 没有合集：不弹合集弹窗，直接下载该视频
          if (item && item.aweme_id) {
            setVideos([item]);
            setSelectedVideos(new Set([0]));
            setSelectedQuality('auto');
            setFetchNotice(null);
            setUserInfo((prev) => prev || { nickname: (item.author && item.author.nickname) || '视频' });
            setShowModal(true);
            setMixModal(false);
            return;
          }
          setError('该视频不属于任何合集，且无法解析视频详情');
          setMixModal(false);
          return;
        }
        const mixEntry = {
          mixId: mix.mix_id,
          mixName: mix.mix_name || mix.name || '未命名合集',
          count: 0,
          cover: (mix.cover_url && mix.cover_url.url_list && mix.cover_url.url_list[0]) || '',
          desc: mix.desc || '',
        };
        setMixes([mixEntry]);
        setMixSecUserId((item.author && item.author.sec_uid) || '');
        setMixModal(true);
        return;
      }

      // 用户主页：聚合该用户全部合集
      const secUserId = await resolveSecUserId(rawInput);
      setMixVideoId('');
      if (!secUserId) {
        setError('无法识别链接，请粘贴抖音用户主页链接或视频链接');
        setMixModal(false);
        return;
      }
      setMixSecUserId(secUserId);
      const list = await fetchMixList(secUserId, () => {});
      setMixes(list);
      if (list.length === 0) {
        setError('该用户没有创建合集（发布作品中未检测到合集信息）');
        setMixModal(false);
        return;
      }
      setMixModal(true);
    } catch (err) {
      setError(err.message || '获取合集列表失败');
      setMixModal(false);
    } finally {
      setMixLoading(false);
    }
  };

  // 选中某个合集：拉取合集内全部作品，打开现有下载弹窗（复用批量下载/导出逻辑）
  const handleDownloadMix = async (mix) => {
    setMixLoading(true);
    try {
      const allVideos = [];
      const seenIds = new Set();
      let cursor = 0;
      let hasMore = true;
      let pageCount = 0;
      while (hasMore && pageCount < 50) {
        pageCount++;
        // api.getMixVideos 前端封装签名是 (mixId, detailId, options)，cursor 必须走 options.cursor
        const r = await api.getMixVideos(mix.mixId, '', { cursor, count: 20 });
        const list = (r && (r.aweme_list || (r.data && r.data.aweme_list))) || [];
        let added = 0;
        for (const v of list) {
          const id = v && (v.aweme_id || v.id);
          if (id && seenIds.has(id)) continue;
          if (id) seenIds.add(id);
          allVideos.push(v);
          added++;
        }
        hasMore = r && r.has_more;
        cursor = (r && (r.cursor || r.max_cursor)) || 0;
        if (!hasMore || added === 0) break;
      }
      if (allVideos.length === 0) {
        setError('该合集暂无作品');
        return;
      }
      // 复用现有弹窗：videos 装合集作品，默认全选
      setVideos(allVideos);
      setSelectedVideos(new Set(allVideos.map((_, i) => i)));
      setSelectedQuality('auto');
      setFetchNotice(null);
      setUserInfo((prev) => prev || { nickname: `合集：${mix.mixName}` });
      setShowModal(true);
      setMixModal(false);

      // 保存合集下载历史
      await saveHistory({
        secUserId: mix.mixId,
        userInfo: { nickname: `合集：${mix.mixName}` },
        videos: allVideos,
        platform: 'douyin',
        downloadType: 'mix',
        sourceUrl: url.trim(),
      });
    } catch (err) {
      setError('拉取合集作品失败：' + (err.message || ''));
    } finally {
      setMixLoading(false);
    }
  };

  // 直接下载当前视频（输入的是视频链接时，弹窗里的「下载当前视频」）
  const handleDownloadCurrentVideo = async () => {
    if (!mixVideoId) return;
    setMixLoading(true);
    try {
      const detail = await api.getVideoDetail(mixVideoId);
      const item = (detail && detail.aweme_detail) || {};
      if (!item || !item.aweme_id) {
        setError('无法解析该视频详情');
        return;
      }
      setVideos([item]);
      setSelectedVideos(new Set([0]));
      setSelectedQuality('auto');
      setFetchNotice(null);
      setUserInfo((prev) => prev || { nickname: (item.author && item.author.nickname) || '视频' });
      setShowModal(true);
      setMixModal(false);
    } catch (err) {
      setError('获取视频详情失败：' + (err.message || ''));
    } finally {
      setMixLoading(false);
    }
  };

  // 关闭合集选择弹窗
  const closeMixModal = () => {
    setMixModal(false);
    setMixes([]);
    setMixVideoId('');
  };

  // ===== 历史记录操作 =====

  // 直接用历史记录：加载已存的 videos，弹同样的弹窗（不重新抓取）
  // 导出 Excel 和确认下载完全复用现有逻辑（videos 是完整 aweme 数组）
  const handleUseHistory = (item) => {
    setUserInfo({
      nickname: item.nickname,
      avatar_thumb: { url_list: item.avatar ? [item.avatar] : [] },
      unique_id: item.unique_id,
      // 兼容导出 Excel 用的 userInfo?.user?.nickname
      user: { nickname: item.nickname, unique_id: item.unique_id, short_id: item.unique_id },
    });
    setVideos(item.videos || []);
    setSelectedVideos(new Set((item.videos || []).map((_, i) => i)));
    setSelectedQuality('auto');
    setFetchNotice(null);
    setShowModal(true);
  };

  // 重新获取作品列表：用历史记录里的 sourceUrl 重新抓取（抓完自动更新历史）
  const handleReloadFromHistory = (item) => {
    if (!item.source_url) {
      setError('该历史记录缺少原始链接，无法重新获取');
      return;
    }
    const storedPlatform = ['douyin', 'tiktok', 'youtube', 'kuaishou', 'bilibili'].includes(item.platform)
      ? item.platform
      : 'douyin';
    const storedDownloadType = item.download_type || 'post';
    setPlatformTab(storedPlatform);
    setDownloadType(storedDownloadType);
    setUrl(item.source_url);
    handleFetchProfile({
      platform: storedPlatform,
      downloadType: storedDownloadType,
      input: item.source_url,
    });
  };

  // 删除单条历史记录
  const handleDeleteHistory = async (key) => {
    if (!confirm('确定删除这条历史记录吗？')) return;
    try {
      const res = await window.electronAPI.profileHistoryRemove(key);
      if (res && res.success) setHistory(res.history || []);
    } catch (e) {
      setError('删除失败：' + (e.message || '未知错误'));
    }
  };

  // 清空当前选项卡对应的历史记录
  const handleClearHistory = async () => {
    const typeLabel = downloadType === 'collection' ? '收藏作品' : downloadType === 'mix' ? '合集下载' : downloadType === 'search' ? '搜索下载' : '发布作品';
    if (!confirm(`确定删除全部【${typeLabel}】的历史记录吗？此操作不可恢复。`)) return;
    try {
      const targetItems = history.filter((item) => (item.download_type || 'post') === downloadType);
      for (const item of targetItems) {
        await window.electronAPI.profileHistoryRemove(item.sec_user_id);
      }
      await loadHistory();
    } catch (e) {
      setError('清空失败：' + (e.message || '未知错误'));
    }
  };

  // 格式化时间戳
  const formatHistoryTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className="profile-download fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon">👤</span>
          主页下载
        </h1>
        <p className="hero-subtitle">
          批量下载用户的发布作品或收藏作品
        </p>
      </div>

      {/* 主页下载 */}
      <div className="card">
        <h2>🔍 获取用户作品</h2>
        <div className="download-form">
          {/* 平台切换：抖音 / TikTok / YouTube / 快手 */}
          <div className="download-platform-tabs">
            <button
              className={`type-tab ${platformTab === 'douyin' ? 'type-tab-active' : ''}`}
              onClick={() => switchPlatform('douyin')}
            >
              抖音
            </button>
            <button
              className={`type-tab ${platformTab === 'tiktok' ? 'type-tab-active' : ''}`}
              onClick={() => switchPlatform('tiktok')}
            >
              TikTok
            </button>
            <button
              className={`type-tab ${platformTab === 'youtube' ? 'type-tab-active' : ''}`}
              onClick={() => switchPlatform('youtube')}
            >
              YouTube
            </button>
            <button
              className={`type-tab ${platformTab === 'kuaishou' ? 'type-tab-active' : ''}`}
              onClick={() => switchPlatform('kuaishou')}
            >
              快手
            </button>
            <button
              className={`type-tab ${platformTab === 'bilibili' ? 'type-tab-active' : ''}`}
              onClick={() => switchPlatform('bilibili')}
            >
              哔哩哔哩
            </button>
          </div>

          <div className="download-type-tabs">
            <button
              className={`type-tab ${downloadType === 'post' ? 'type-tab-active' : ''}`}
              onClick={() => setDownloadType('post')}
            >
              发布作品
            </button>
            {platformTab === 'douyin' && (
              <button
                className={`type-tab ${downloadType === 'collection' ? 'type-tab-active' : ''}`}
                onClick={() => setDownloadType('collection')}
              >
                收藏作品
              </button>
            )}
            {platformTab === 'douyin' && (
              <button
                className={`type-tab ${downloadType === 'like' ? 'type-tab-active' : ''}`}
                onClick={() => setDownloadType('like')}
                title="输入用户主页链接（自动带上 showTab=like），抓取该用户公开的喜欢列表"
              >
                用户喜欢
              </button>
            )}
            {platformTab === 'douyin' && (
              <button
                className={`type-tab ${downloadType === 'mix' ? 'type-tab-active' : ''}`}
                onClick={() => setDownloadType('mix')}
                title="输入用户主页链接后点「获取作品」：解析该用户的合集，选择后可下载合集内的全部作品"
              >
                合集下载
              </button>
            )}
            {platformTab === 'douyin' && (
              <button
                className={`type-tab ${downloadType === 'search' ? 'type-tab-active' : ''}`}
                onClick={() => setDownloadType('search')}
                title="输入关键词搜索抖音视频，结果可勾选批量下载"
              >
                抖音搜索下载
              </button>
            )}
          </div>

          {platformTab === 'youtube' && (
          <div className="tips" style={{ marginBottom: 20 }}>
            <span>💡</span>
            <span>输入 YouTube 频道主页地址（需含 @频道名），按下方页数限制抓取该频道的 Shorts，勾选后用 yt-dlp 批量下载</span>
          </div>
          )}

          <div className="settings-row">
            <label className="settings-label">
              获取页数限制:
              <select
                className="settings-select"
                value={maxPages}
                onChange={(e) => setMaxPages(parseInt(e.target.value))}
              >
                <option value={5}>5页 (约100个作品)</option>
                <option value={10}>10页 (约200个作品)</option>
                <option value={20}>20页 (约400个作品)</option>
                <option value={50}>50页 (约1000个作品)</option>
                <option value={100}>100页 (约2000个作品)</option>
                <option value={999}>全部获取</option>
              </select>
            </label>
          </div>

          <div className="input-group">
            <input
              type="text"
              className="form-input url-input"
              placeholder={platformTab === 'youtube'
                ? '粘贴 YouTube 频道主页地址，如 https://www.youtube.com/@iamfromkorea/shorts'
                : (platformTab === 'kuaishou'
                    ? '粘贴快手主页链接，如 https://www.kuaishou.com/profile/3x9bby984bftshc'
                    : (platformTab === 'bilibili'
                        ? '粘贴 B 站空间主页链接，如 https://space.bilibili.com/946974/video'
                        : (downloadType === 'search'
                            ? '输入搜索关键词，如：红烧肉（支持多页获取）'
                            : (downloadType === 'like'
                                ? '粘贴用户主页链接，如 https://www.douyin.com/user/xxx（自动带上 showTab=like）'
                                : (platformTab === 'tiktok'
                                    ? '粘贴 TikTok 主页链接或 @用户名，如 @username'
                                    : '粘贴抖音主页链接或 sec_user_id...')))))}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleFetchProfile()}
            />
            <button
              className="btn btn-primary"
              onClick={() => handleFetchProfile()}
              disabled={(loading || mixLoading || youtubeLoading) || !url.trim() || !pythonRunning}
            >
              {loading || mixLoading || youtubeLoading ? (
                <>
                  <span className="loading-spinner"></span>
                  {platformTab === 'youtube'
                    ? (youtubeLoading ? '抓取 Shorts 中...' : '获取中...')
                    : downloadType === 'search' || downloadType === 'like'
                      ? (fetchProgress.total > 0 ? `${downloadType === 'search' ? '搜索' : '获取'}中 ${fetchProgress.current}/${fetchProgress.total}页` : '获取中...')
                      : downloadType === 'mix' ? '解析合集中...' : (fetchProgress.total > 0 ? `获取中 ${fetchProgress.current}页` : '获取中...')}
                </>
              ) : (
                <>
                  <span>📥</span>
                  {platformTab === 'youtube' ? '获取 Shorts' : downloadType === 'search' ? '搜索' : downloadType === 'mix' ? '获取合集' : '获取作品'}
                </>
              )}
            </button>
          </div>

          <div className="tips">
            <span>💡</span>
            <span>
              {platformTab === 'youtube'
                ? '抓取该频道的全部 Shorts（含标题/播放量），勾选后用 yt-dlp 批量下载，无需登录'
                : (platformTab === 'kuaishou'
                    ? '粘贴快手主页链接，获取该用户发布的全部作品（需先在「登录平台账号」登录快手），勾选后批量下载'
                    : (platformTab === 'bilibili'
                        ? '粘贴 B 站空间主页链接（含 UID），获取该 UP 主发布的全部投稿，勾选后用 yt-dlp 批量下载。未登录最高 720P，登录后可选 1080P'
                        : (downloadType === 'search'
                            ? '输入关键词搜索抖音视频，结果可勾选后批量下载，自动保存搜索历史'
                            : (downloadType === 'like'
                                ? '粘贴用户主页链接（自动带上 showTab=like），抓取该用户公开的喜欢列表；对方未公开时会有提示'
                                : (platformTab === 'tiktok'
                                    ? '粘贴 TikTok 主页链接或 @用户名，获取其发布的视频'
                                    : '粘贴抖音主页链接或直接输入 sec_user_id')))))}
            </span>
          </div>
        </div>

        {/* 获取进度（抖音/合集/搜索/喜欢/快手） */}
        {loading && (fetchProgress.total > 0 || downloadType === 'like') && (
          <div className="fetch-progress">
            <div className="fetch-progress-header">
              <span className="progress-label">获取进度</span>
              <span className="progress-count">
                {downloadType === 'like'
                  ? (likedStage === 'scroll'
                      ? `滚动加载 ${fetchProgress.current}/${fetchProgress.total} 次 · 已捕获 ${fetchProgress.fetched || 0} 个分页`
                      : `${fetchProgress.current}/${fetchProgress.total} 页 · 已获取 ${fetchProgress.fetched || 0} 条`)
                  : (downloadType === 'search' || platformTab === 'kuaishou' || platformTab === 'bilibili'
                      ? `${fetchProgress.current}/${fetchProgress.total} 页 · 已获取 ${fetchProgress.fetched || 0} 条`
                      : `${fetchProgress.current} 页`)}
              </span>
            </div>
            <div className="progress-bar-container">
              <div className="progress-bar" style={{ width: `${Math.min(100, Math.round((fetchProgress.current / fetchProgress.total) * 100))}%` }}></div>
            </div>
            <span className="progress-text">
              {downloadType === 'search' ? `正在搜索「${url.trim() || '关键词'}」第 ${fetchProgress.current}/${fetchProgress.total} 页...`
                : downloadType === 'like'
                  ? (likedStage === 'scroll'
                      ? `正在滚动加载喜欢页（第 ${fetchProgress.current}/${fetchProgress.total} 次）...`
                      : `正在获取喜欢作品第 ${fetchProgress.current}/${fetchProgress.total} 页...`)
                  : (platformTab === 'kuaishou'
                      ? `正在获取快手作品第 ${fetchProgress.current}/${fetchProgress.total} 页...`
                      : (platformTab === 'bilibili'
                          ? `正在获取哔哩哔哩投稿第 ${fetchProgress.current}/${fetchProgress.total} 页...`
                          : `正在获取第 ${fetchProgress.current} 页作品...`))}
            </span>
          </div>
        )}

        {/* YouTube Shorts 抓取进度 */}
        {youtubeLoading && youtubeProgress.fetched > 0 && (
          <div className="fetch-progress">
            <div className="fetch-progress-header">
              <span className="progress-label">抓取进度</span>
              <span className="progress-count">已获取 {youtubeProgress.fetched} 条</span>
            </div>
            <div className="progress-bar-container">
              <div className="progress-bar loading-bar"></div>
            </div>
            <span className="progress-text">
              正在抓取 Shorts（第 {youtubeProgress.page} 页）...
            </span>
          </div>
        )}

        {error && (
          <div className="alert alert-danger">
            ❌ {error}
          </div>
        )}

        {userInfo && !showModal && (
          <div className="user-info-section">
            <h3>✓ 用户信息</h3>
            <div className="user-info-card">
              <div className="user-avatar">
                {userInfo.avatar_thumb?.url_list?.[0] && (
                  <img src={userInfo.avatar_thumb.url_list[0]} alt={userInfo.nickname} />
                )}
              </div>
              <div className="user-details">
                <h4>{userInfo.nickname}</h4>
                {platformTab === 'bilibili' ? (
                  <>
                    <p>UID: {userInfo.mid || userInfo.uid}</p>
                    {userInfo.isLoggedIn ? (
                      <p className="bili-login-badge" style={{ color: '#00a1d6' }}>✅ 已登录哔哩哔哩（{userInfo.loginName || '已登录'}），可下载 1080P</p>
                    ) : (
                      <p className="bili-login-badge" style={{ color: '#e6a23c' }}>⚠️ 未登录 B 站，最高可下载 720P；在「登录平台账号」登录哔哩哔哩后可下载 1080P</p>
                    )}
                  </>
                ) : (
                  <>
                    <p>抖音号: {userInfo.unique_id || userInfo.short_id}</p>
                    <p>简介: {userInfo.signature || '无'}</p>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 历史记录（按当前选中的类型：“发布作品 / 收藏作品 / 合集下载 / 搜索下载” 分开展示） */}
        {(() => {
          const filteredHistory = history.filter((item) => (item.download_type || 'post') === downloadType);
          const historyTitle = downloadType === 'collection'
            ? '收藏作品历史记录'
            : downloadType === 'mix'
            ? '合集下载历史记录'
            : downloadType === 'search'
            ? '搜索下载历史记录'
            : '发布作品历史记录';
          const historyEmptyText = downloadType === 'collection'
            ? '暂无【收藏作品】历史记录，抓取后将自动保存'
            : downloadType === 'mix'
            ? '暂无【合集下载】历史记录，下载合集后将自动保存'
            : downloadType === 'search'
            ? '暂无【搜索下载】历史记录，搜索后将自动保存'
            : '暂无【发布作品】历史记录，抓取后将自动保存';

          return (
            <div className="profile-history-section">
              <div className="profile-history-header">
                <h3>🕐 {historyTitle} ({filteredHistory.length})</h3>
                {filteredHistory.length > 0 && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleClearHistory}
                    type="button"
                  >
                    🗑 清空当前列表历史
                  </button>
                )}
              </div>

              {filteredHistory.length === 0 ? (
                <div className="history-empty">{historyEmptyText}</div>
              ) : (
                <div className="profile-history-list">
                  {filteredHistory.map((item) => (
                    <div key={item.sec_user_id} className="profile-history-item">
                      <div className="history-item-main">
                        <div className="history-item-avatar">
                          {item.avatar
                            ? <img src={item.avatar} alt="" onError={(e) => { e.target.style.display = 'none'; }} />
                            : <span className="history-avatar-fallback">👤</span>}
                        </div>
                        <div className="history-item-info">
                          <div className="history-item-title">
                            {item.nickname || '未知用户'}
                            {item.download_type === 'collection' && (
                              <span className="history-type-tag">收藏</span>
                            )}
                            {item.download_type === 'mix' && (
                              <span className="history-type-tag history-type-mix">合集</span>
                            )}
                            {item.download_type === 'search' && (
                              <span className="history-type-tag history-type-search">搜索</span>
                            )}
                            {item.platform === 'tiktok' && (
                              <span className="history-type-tag history-type-tiktok">TikTok</span>
                            )}
                            {item.platform === 'kuaishou' && (
                              <span className="history-type-tag history-type-tiktok">快手</span>
                            )}
                            {item.platform === 'bilibili' && (
                              <span className="history-type-tag history-type-tiktok">哔哩哔哩</span>
                            )}
                          </div>
                          <div className="history-item-meta">
                            <span>📦 {item.video_count} 个作品</span>
                            {item.unique_id && <span> · 🆔 {item.unique_id}</span>}
                            <span> · 🕒 {formatHistoryTime(item.updated_time)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="history-item-actions">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleReloadFromHistory(item)}
                          type="button"
                          title="用原始链接重新抓取最新作品列表"
                        >
                          🔄 重新获取
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleUseHistory(item)}
                          type="button"
                          title="直接使用历史记录的作品列表（不重新抓取）"
                        >
                          📂 用历史记录
                        </button>
                        <button
                          className="btn btn-secondary btn-sm history-delete-btn"
                          onClick={() => handleDeleteHistory(item.sec_user_id)}
                          type="button"
                          title="删除此条历史记录"
                        >
                          🗑 删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* 批量下载弹窗 */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>作品列表 ({videos.length} 个作品)</h3>
              <button type="button" className="modal-close" onClick={closeModal}>×</button>
            </div>

            {fetchNotice && (
              <div className={`profile-fetch-notice ${fetchNotice.type === 'partial' ? 'is-partial' : 'is-limit'}`}>
                <span className="profile-fetch-notice-icon">⚠️</span>
                <span className="profile-fetch-notice-text">{fetchNotice.message}</span>
              </div>
            )}

            <div className="modal-body">
              <div className="select-all-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedVideos.size === videos.length && selectedVideos.size > 0}
                    onChange={toggleSelectAll}
                  />
                  <span>全选 ({selectedVideos.size}/{videos.length})</span>
                </label>
                {availableQualities.length > 1 && (
                  <div className="quality-selector">
                    <span className="quality-label">默认清晰度:</span>
                    <select
                      className="quality-select"
                      value={selectedQuality}
                      onChange={(e) => setSelectedQuality(e.target.value)}
                    >
                      {availableQualities.map((q) => (
                        <option key={q.value} value={q.value}>{q.label}</option>
                      ))}
                    </select>
                    {platformTab === 'bilibili' && (
                      <span className="quality-hint">
                        {userInfo?.isLoggedIn
                          ? '已登录，可选 1080P'
                          : '未登录，最高 720P（登录后可选 1080P）'}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="video-list">
                {videos.map((video, index) => (
                  <div key={index} className="video-item">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedVideos.has(index)}
                        onChange={() => toggleVideoSelection(index)}
                      />
                      <div className="video-item-info">
                        <div className="video-item-title">
                          {video.is_top === 1 && (
                            <span className="video-pin-badge" title="该作品被作者置顶">📌 置顶</span>
                          )}
                          {video.desc?.substring(0, 60) || '无标题'}
                          {video.desc?.length > 60 ? '...' : ''}
                        </div>
                        <div className="video-item-meta">
                          点赞: {video.statistics?.digg_count || 0} |
                          评论: {video.statistics?.comment_count || 0}
                        </div>
                      </div>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleExportVideos}
                disabled={videos.length === 0}
                title="将当前列表的作品数据导出为 Excel 文件（含类型/发布时间/文案/合集/点赞/评论/收藏/分享/推荐此书/时长/链接）"
              >
                📊 导出 Excel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleBatchDownload}
                disabled={selectedVideos.size === 0 || batchDownloading}
              >
                {batchDownloading ? '下载中...' : `确认下载 (${selectedVideos.size})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 合集选择弹窗 */}
      {mixModal && (
        <div className="modal-overlay" onClick={closeMixModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{mixVideoId ? '下载视频 / 合集' : '选择合集'} ({mixes.length})</h3>
              <button type="button" className="modal-close" onClick={closeMixModal}>×</button>
            </div>
            <div className="modal-body">
              {mixVideoId && (
                <div className="mix-video-download">
                  <button
                    className="btn btn-primary"
                    onClick={handleDownloadCurrentVideo}
                    disabled={mixLoading}
                    title="直接下载当前粘贴的这个视频"
                  >
                    ▶ 下载当前视频
                  </button>
                  <span className="mix-video-hint">
                    或从下方选择合集，下载该视频所属合集的全部作品
                  </span>
                </div>
              )}
              <div className="mix-list-hint">
                {mixVideoId ? '该视频所属的合集：' : '检测到该用户的以下合集，点击合集可下载其全部作品'}
              </div>
              <div className="mix-list">
                {mixes.map((mix) => (
                  <div key={mix.mixId} className="mix-item">
                    {mix.cover ? (
                      <img className="mix-item-cover" src={mix.cover} alt="" onError={(e) => { e.target.style.display = 'none'; }} />
                    ) : (
                      <span className="mix-item-cover mix-item-cover-fallback">📚</span>
                    )}
                    <div className="mix-item-info">
                      <div className="mix-item-name" title={mix.mixName}>{mix.mixName}</div>
                      <div className="mix-item-meta">
                        {mix.count > 0 ? `检测到 ${mix.count} 个作品` : '作品数未知'}
                        {mix.desc ? ` · ${mix.desc.slice(0, 30)}` : ''}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleDownloadMix(mix)}
                      disabled={mixLoading}
                    >
                      下载合集
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeMixModal}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProfileDownload;
