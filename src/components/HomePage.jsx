import React, { useState } from 'react';
import api from '../utils/api';
import { isImageWork, buildImageWorkItems, extractQualityOptions, pickQualityUrl } from '../utils/douyinWork';
import { successfulIndices } from '../utils/downloadUi.mjs';
import './HomePage.css';
import QuickBrowser from './QuickBrowser';
import {
  Download, Sparkles, AlertCircle,
} from './icons';

function HomePage({ pythonRunning = false, onNavigate }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // 批量解析状态
  const [parsedVideos, setParsedVideos] = useState([]);
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0 });
  const [showModal, setShowModal] = useState(false);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [batchDownloading, setBatchDownloading] = useState(false);
  // 批量下载默认清晰度（仅抖音视频有效，'auto'=默认最高）
  const [selectedQuality, setSelectedQuality] = useState('auto');

  const handleDownload = async () => {
    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }

    if (!url.trim()) {
      setError('请输入有效的链接');
      return;
    }

    // 解析多个链接（按行分割）
    // 每行可能是纯链接，也可能是抖音/TikTok 分享口令（整段文字+链接），先从中提取出 URL
    const URL_RE = /(https?:\/\/[^\s"'<>\u4e00-\u9fa5]+)/gi;
    const urls = url.split('\n').map(u => u.trim()).filter(u => u)
      // 如果整行就是纯 URL（无空格），直接用；否则从文本里提取第一个 URL
      .map((line) => {
        if (!/\s/.test(line) && /^https?:\/\//i.test(line)) return line;
        const m = line.match(URL_RE);
        return m && m[0] ? m[0] : line; // 提取不到就保留原行（后面会报"无法识别"）
      });

    if (urls.length === 0) {
      setError('请输入有效的链接');
      return;
    }

    setLoading(true);
    setError(null);
    setParsedVideos([]);
    setSelectedQuality('auto');
    setParseProgress({ current: 0, total: urls.length });

    const results = [];

    try {
      for (let i = 0; i < urls.length; i++) {
        setParseProgress({ current: i + 1, total: urls.length });

        try {
          const currentUrl = urls[i];

          // TikTok 链接：走多平台解析器（tikwm 原生解析，不走抖音 getVideoDetail）
          // 多平台解析器返回标准格式 {platform, type, title, author, video:{url}, images}
          if (/tiktok\.com/i.test(currentUrl)) {
            try {
              const result = await window.electronAPI.parseVideoLink(currentUrl);
              if (result && result.success && result.data) {
                results.push({
                  url: currentUrl,
                  data: result.data,
                  success: true,
                  platform: result.data.platform || 'tiktok',
                  native: true,
                });
              } else {
                results.push({
                  url: currentUrl,
                  error: (result && result.error) || 'TikTok 解析失败',
                  success: false,
                });
              }
            } catch (err) {
              results.push({
                url: currentUrl,
                error: err.message || 'TikTok 解析失败',
                success: false,
              });
            }
            continue;
          }

          // 1. 先尝试从原始URL中提取ID
          let detailId;

          // 检查 modal_id 参数（用户主页弹窗链接）
          const modalIdMatch = currentUrl.match(/modal_id=(\d+)/);
          if (modalIdMatch) {
            detailId = modalIdMatch[1];
            console.log('从modal_id提取到作品ID:', detailId);
          }

          // 检查 /video/ 路径
          if (!detailId) {
            const videoMatch = currentUrl.match(/video\/(\d+)/);
            if (videoMatch) {
              detailId = videoMatch[1];
              console.log('从video路径提取到作品ID:', detailId);
            }
          }

          // 2. 如果原始URL没有提取到，尝试解析短链接
          if (!detailId) {
            const resolved = await api.resolveShareLink(currentUrl);
            console.log('解析后的链接:', resolved);

            if (resolved) {
              // 检查解析后的 modal_id
              const resolvedModalMatch = resolved.match(/modal_id=(\d+)/);
              if (resolvedModalMatch) {
                detailId = resolvedModalMatch[1];
                console.log('从解析后链接的modal_id提取到作品ID:', detailId);
              }

              // 检查解析后的 /video/ 路径
              if (!detailId && resolved.includes('/video/')) {
                const idMatch = resolved.match(/video\/(\d+)/);
                if (idMatch) {
                  detailId = idMatch[1];
                  console.log('从解析后链接的video路径提取到作品ID:', detailId);
                }
              }

              // 检查解析后的 /note/、/slides/ 路径（图集/图文分享格式，如 iesdouyin.com/share/slides/xxx）
              if (!detailId) {
                const slidesMatch = resolved.match(/slides\/(\d+)/) || resolved.match(/note\/(\d+)/);
                if (slidesMatch) {
                  detailId = slidesMatch[1];
                  console.log('从解析后链接的slides/note路径提取到作品ID:', detailId);
                }
              }

              // 兜底：解析后的链接里提取 19 位抖音作品ID（v.douyin.com 短链解析结果多变，
              // 但作品 ID 固定 19 位，直接抓数字最可靠）
              if (!detailId) {
                const digitsMatch = resolved.match(/\d{19}/);
                if (digitsMatch) {
                  detailId = digitsMatch[0];
                  console.log('从解析后链接的19位数字提取到作品ID:', detailId);
                }
              }
            }
          }

          // 3. 检查是否直接输入了纯数字ID
          if (!detailId && /^\d+$/.test(currentUrl.trim())) {
            detailId = currentUrl.trim();
            console.log('使用纯数字作品ID:', detailId);
          }

          if (!detailId) {
            results.push({
              url: currentUrl,
              error: '无法识别的链接格式',
              success: false
            });
            continue;
          }

          // 3. 获取作品详情
          const detail = await api.getVideoDetail(detailId);

          if (!detail || Object.keys(detail).length === 0) {
            results.push({
              url: currentUrl,
              error: '获取详情失败，请检查登录状态',
              success: false
            });
            continue;
          }

          const videoData = detail.aweme_detail || detail;
          results.push({
            url: currentUrl,
            data: videoData,
            success: true
          });

        } catch (err) {
          results.push({
            url: urls[i],
            error: err.message || '解析失败',
            success: false
          });
        }
      }

      // 显示弹窗
      setParsedVideos(results);
      setSelectedVideos(successfulIndices(results));
      setShowModal(true);

    } catch (err) {
      console.error('解析错误:', err);
      setError(err.message || '解析失败');
    } finally {
      setLoading(false);
      setParseProgress({ current: 0, total: 0 });
    }
  };

  // 计算可选清晰度：取所有成功解析的抖音视频 bit_rate 档位的交集
  // （只显示"所有视频都支持"的档位，避免选了某档但部分视频没有而反复降级）
  const availableQualities = (() => {
    const douyinVideos = parsedVideos.filter(v => v.success && !v.native && !isImageWork(v.data));
    if (douyinVideos.length === 0) return [];
    // 每个视频的可选档位 value 集合
    const perVideoSets = douyinVideos.map(v => new Set(
      extractQualityOptions(v.data).map(q => q.value)
    ));
    // 交集（排除 'auto'，它单独作为首项）
    const common = [...perVideoSets[0]].filter(val =>
      val !== 'auto' && perVideoSets.every(s => s.has(val))
    );
    // 解析出 label（从第一个视频里取）
    const firstOpts = extractQualityOptions(douyinVideos[0].data);
    const result = [{ label: '默认（最高）', value: 'auto' }];
    for (const val of common) {
      const opt = firstOpts.find(o => o.value === val);
      if (opt) result.push({ label: opt.label, value: opt.value });
    }
    return result;
  })();

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
    const acceptedIndices = successfulIndices(parsedVideos);

    if (selectedVideos.size === acceptedIndices.size) {
      setSelectedVideos(new Set());
    } else {
      setSelectedVideos(acceptedIndices);
    }
  };

  // 批量下载
  const handleBatchDownload = async () => {
    if (selectedVideos.size === 0) return;

    setBatchDownloading(true);

    try {
      // 统一批次：所有选中的视频进入同一个文件夹 + 下载管理按批分组
      const batchId = `home_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const folderName = `快速下载--${new Date().toISOString().slice(0, 10)}`;
      const batchInfo = { nickname: folderName, authorName: '快速下载', profileUrl: '', avatar: '', platform: 'multiplatform', folderName };
      const batchOptions = { customDir: folderName, batchId, batchInfo };

      // 直接投放所有下载任务，不等待完成
      const downloadPromises = [];

      for (const index of selectedVideos) {
        const video = parsedVideos[index];
        if (!video.success || !video.data) continue;

        // 原生解析器结果（TikTok 等）：data 是标准格式，直接取 video.url/images
        if (video.native) {
          const d = video.data;
          const plat = video.platform || d.platform || 'tiktok';
          const videoInfo = {
            desc: d.title,
            title: d.title,
            author: d.author?.name,
            platform: plat,
            // 作品页面链接：下载管理展示用（用户输入的原始链接，稳定且一定是视频页）
            sourceUrl: video.url || '',
          };

          // 图集
          if (d.type === 'image' && Array.isArray(d.images) && d.images.length > 0) {
            const items = d.images.map((img, i) => ({
              url: img.url,
              filename: `${(d.title || plat + '_img').substring(0, 40)}_${i + 1}.jpg`,
            }));
            downloadPromises.push(
              window.electronAPI.downloadAlbum(items, videoInfo, plat, batchOptions)
            );
            continue;
          }

          // 视频
          const videoUrl = d.video?.url || d.video?.urlNoWatermark;
          if (!videoUrl) continue;
          const filename = `${(d.title || plat + '_video').substring(0, 50)}_${d.author?.uid || Date.now()}.mp4`
            .replace(/[<>:"/\\|?*\n\r]/g, '_');
          downloadPromises.push(
            window.electronAPI.downloadFile(videoUrl, filename, videoInfo, plat, batchOptions)
          );
          continue;
        }

        // 抖音 aweme_detail 结构
        const videoData = video.data;

        // 构造 videoInfo（图集下载需要 title/platform 字段）
        const videoInfo = {
          desc: videoData.desc,
          title: videoData.desc,
          author: videoData.author?.nickname,
          uid: videoData.author?.uid,
          create_time: videoData.create_time,
          awemeId: videoData.aweme_id,
          platform: 'douyin',
          // 作品页面链接：下载管理展示用，优先用抖音返回的 share_url，没有则用用户输入链接
          sourceUrl: videoData.share_url || video.url || '',
        };

        // 1) 图文作品（图集+背景音乐）：images 有图片且无真视频流
        //    注意：图文作品的 video.play_addr 实际是 BGM，不能当 mp4 下载
        if (isImageWork(videoData)) {
          const items = buildImageWorkItems(videoData);
          if (items.length > 0) {
            downloadPromises.push(
              window.electronAPI.downloadAlbum(items, videoInfo, 'douyin', batchOptions)
            );
          }
          continue;
        }

        // 2) 普通视频作品：按用户选择的清晰度取直链（找不到则降级用默认最高）
        const videoUrl = pickQualityUrl(videoData, selectedQuality);

        if (!videoUrl) continue;

        // 生成文件名
        const filename = `${videoData.desc?.substring(0, 50) || 'douyin_video'}_${videoData.aweme_id || Date.now()}.mp4`;
        const sanitizedFilename = filename.replace(/[<>:"/\\|?*\n\r]/g, '_');

        // 不等待，直接投放
        downloadPromises.push(
          window.electronAPI.downloadFile(videoUrl, sanitizedFilename, videoInfo, 'douyin', batchOptions)
        );
      }

      // IPC 返回只代表任务是否成功入队，不等待实际下载完成。
      const settledResults = await Promise.allSettled(downloadPromises);
      const acceptedCount = settledResults.filter(result =>
        result.status === 'fulfilled' && result.value?.success !== false
      ).length;
      const failedCount = settledResults.length - acceptedCount;

      if (acceptedCount === 0) {
        setError(downloadPromises.length === 0
          ? '没有可提交的下载内容'
          : '下载任务均未能添加，请稍后重试');
        return;
      }

      // 至少一个任务成功入队后才关闭弹窗并跳转。
      setShowModal(false);
      setParsedVideos([]);
      setSelectedVideos(new Set());

      // 提示用户任务已添加
      console.log(`已添加 ${acceptedCount} 个下载任务到下载管理`);
      setError(failedCount > 0
        ? `已添加 ${acceptedCount} 个任务，${failedCount} 个任务添加失败`
        : null);

      // 跳转到下载管理的「下载中」标签
      if (acceptedCount > 0 && onNavigate) {
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
    setParsedVideos([]);
    setSelectedVideos(new Set());
  };

  return (
    <div className="home-page fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon"><Download size={24} /></span>
          抖音-TikTok 多平台
        </h1>
        <p className="hero-subtitle">
          多平台无水印下载视频/图集/音乐 | 支持批量下载 | 支持直播录制 | 18+平台支持
        </p>
      </div>

      {/* 快速下载 */}
      <div className="card quick-download-card">
        <h2 className="card-h2">
          <Sparkles size={18} className="card-h2-icon" />
          快速下载
        </h2>
        <div className="download-form">
          <div className="input-group">
            <textarea
              className="form-input url-input"
              placeholder="粘贴抖音 / TikTok / B站等18+平台链接或作品ID...&#10;支持多个链接，每行一个"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              rows={6}
            />
            <button
              className="btn btn-primary download-btn"
              onClick={handleDownload}
              disabled={loading || !url.trim() || !pythonRunning}
              title={!pythonRunning ? 'Python后端未运行' : ''}
            >
              {loading ? (
                <>
                  <span className="loading-spinner"></span>
                  {parseProgress.total > 1
                    ? `解析中 ${parseProgress.current}/${parseProgress.total}`
                    : '解析中...'}
                </>
              ) : (
                <>
                  <Download size={16} />
                  解析下载
                </>
              )}
            </button>
          </div>
        </div>

        {/* 解析进度条 */}
        {loading && parseProgress.total > 0 && (
          <div className="parse-progress">
            <div className="parse-progress-header">
              <span className="progress-label">解析进度</span>
              <span className="progress-count">{parseProgress.current} / {parseProgress.total}</span>
            </div>
            <div className="progress-bar-container">
              <div
                className="progress-bar"
                style={{ width: `${(parseProgress.current / parseProgress.total) * 100}%` }}
              ></div>
            </div>
            <span className="progress-text">
              正在解析第 {parseProgress.current} 个链接...
            </span>
          </div>
        )}

        {error && (
          <div className="alert alert-danger">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* 内置浏览器：浏览抖音页面自动收集作品链接，可一键复制（一行一个）或填入下载框 */}
        <QuickBrowser onAddLinks={(list) => setUrl(list.join('\n'))} />
      </div>

      {/* 批量下载弹窗 */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>解析结果</h3>
              <button type="button" className="modal-close" onClick={closeModal}>×</button>
            </div>

            <div className="modal-body">
              <div className="select-all-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedVideos.size === parsedVideos.filter(v => v.success).length && selectedVideos.size > 0}
                    onChange={toggleSelectAll}
                  />
                  <span>全选 ({selectedVideos.size}/{parsedVideos.filter(v => v.success).length})</span>
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
                  </div>
                )}
              </div>

              <div className="video-list">
                {parsedVideos.map((video, index) => (
                  <div
                    key={index}
                    className={`video-item ${video.success ? '' : 'video-item-error'}`}
                  >
                    {video.success ? (
                      <>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={selectedVideos.has(index)}
                            onChange={() => toggleVideoSelection(index)}
                          />
                          <div className="video-item-info">
                            <div className="video-item-title">
                              {video.native ? (
                                <>
                                  {video.data.type === 'image' && <span className="work-type-tag">图文</span>}
                                  <span className="work-type-tag">{video.data.platformName || video.platform}</span>
                                  {video.data.title?.substring(0, 60) || '无标题'}
                                  {video.data.title?.length > 60 ? '...' : ''}
                                </>
                              ) : (
                                <>
                                  {isImageWork(video.data) && <span className="work-type-tag">图文</span>}
                                  {video.data.desc?.substring(0, 60) || '无标题'}
                                  {video.data.desc?.length > 60 ? '...' : ''}
                                </>
                              )}
                            </div>
                            <div className="video-item-author">
                              作者: {video.native ? (video.data.author?.name || '未知') : (video.data.author?.nickname || '未知')}
                            </div>
                          </div>
                        </label>
                      </>
                    ) : (
                      <div className="video-item-error-content">
                        <span className="error-icon">❌</span>
                        <div className="video-item-info">
                          <div className="video-item-title">{video.url}</div>
                          <div className="video-item-error-msg">{video.error}</div>
                        </div>
                      </div>
                    )}
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
    </div>
  );
}

export default HomePage;
