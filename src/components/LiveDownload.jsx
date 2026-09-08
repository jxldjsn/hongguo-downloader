import React, { useState } from 'react';
import api from '../utils/api';
import { dispatchResource } from '../utils/downloadUi.mjs';
import './LiveDownload.css';

function LiveDownload({ pythonRunning = false }) {
  const [url, setUrl] = useState('');
  const [platform, setPlatform] = useState('douyin'); // douyin | bilibili
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [liveInfo, setLiveInfo] = useState(null);
  const [recording, setRecording] = useState(false);

  // 获取直播信息
  const handleFetchLive = async () => {
    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }

    if (!url.trim()) {
      setError('请输入有效的直播间链接');
      return;
    }

    setLoading(true);
    setError(null);
    setLiveInfo(null);

    try {
      if (platform === 'bilibili') {
        // ===== B 站直播 =====
        const res = await window.electronAPI.biliGetLiveStream(url.trim());
        if (!res || !res.success) {
          throw new Error(res?.error || '获取 B 站直播间信息失败');
        }
        const info = res.data;
        if (info.live_status !== 1) {
          // 未开播：仍展示房间信息，但提示未开播
          setLiveInfo({ ...info, isBili: true, notLive: true });
          setError(`该直播间当前未开播（状态: ${info.live_status === 2 ? '轮播中' : '未开播'}），开播后可录制`);
        } else if (!info.stream_url) {
          setLiveInfo({ ...info, isBili: true, notLive: true });
          setError('已开播但未取到流地址，可能是受限直播间（需登录）');
        } else {
          setLiveInfo({ ...info, isBili: true });
        }
      } else {
        // ===== 抖音直播（原逻辑） =====
        // 1. 解析链接获取 webRid 或 room_id
        let webRid = url.trim();

        // 如果是完整链接，提取 webRid
        if (url.includes('douyin.com') || url.includes('live.douyin.com')) {
          // 从URL中提取webRid或room_id
          // 例如: https://live.douyin.com/123456789
          const match = url.match(/live\.douyin\.com\/(\w+)/);
          if (match) {
            webRid = match[1];
          } else {
            // 尝试解析短链接
            try {
              const resolved = await api.resolveShareLink(url);
              console.log('解析后的链接:', resolved);
              const resolvedMatch = resolved.match(/live\.douyin\.com\/(\w+)/);
              if (resolvedMatch) {
                webRid = resolvedMatch[1];
              }
            } catch (err) {
              console.warn('链接解析失败:', err);
            }
          }
        }

        console.log('webRid:', webRid);

        // 2. 获取直播信息
        const liveData = await api.getLiveStream(webRid);
        console.log('直播信息:', liveData);

        if (!liveData || !liveData.data) {
          throw new Error('获取直播信息失败，可能该直播间不存在');
        }

        const roomData = liveData.data;
        console.log('房间数据:', roomData);

        // 获取实际的直播间数据（在data数组的第一个元素）
        let actualRoomData = roomData;
        if (roomData.data && Array.isArray(roomData.data) && roomData.data.length > 0) {
          actualRoomData = roomData.data[0];
          console.log('实际直播间数据:', actualRoomData);
        }

        console.log('直播状态:', actualRoomData.status);

        // 检查直播流地址
        if (!actualRoomData.stream_url && !actualRoomData.data?.stream_url) {
          throw new Error(`该直播间未开播 (状态: ${actualRoomData.status})`);
        }

        setLiveInfo(actualRoomData);
      }

    } catch (err) {
      console.error('获取失败:', err);
      setError(err.message || '获取失败');
    } finally {
      setLoading(false);
    }
  };

  // 复制链接
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      alert('已复制到剪贴板');
    }).catch(err => {
      console.error('复制失败:', err);
      alert('复制失败，请手动复制');
    });
  };

  // 开始录制
  const handleStartRecording = async (streamInfo) => {
    setRecording(true);
    setError(null);

    try {
      // 生成文件名 - 使用直播间标题
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
      let roomTitle;
      let videoInfo;
      const streamUrl = streamInfo?.url || '';
      const streamLabel = String(streamInfo?.type || '').toLowerCase();
      const resourceType = /^rtmps?:\/\//i.test(streamUrl) || streamLabel.includes('rtmp')
        ? 'rtmp'
        : (streamLabel.includes('hls') || /\.m3u8(?:\?|$)/i.test(streamUrl) ? 'm3u8' : 'video');
      const ext = resourceType === 'm3u8' ? '.mp4' : '.flv';

      if (liveInfo.isBili) {
        roomTitle = liveInfo.title || `bilibili_${liveInfo.room_id}`;
        videoInfo = {
          desc: liveInfo.title || 'B站直播录制',
          author: liveInfo.uname || '',
          awemeId: String(liveInfo.room_id),
          platform: 'bilibili',
        };
      } else {
        roomTitle = liveInfo.title || liveInfo.owner?.nickname || 'douyin';
        videoInfo = {
          desc: liveInfo.title || `${liveInfo.owner?.nickname || '未知'}的直播`,
          author: liveInfo.owner?.nickname,
          awemeId: liveInfo.room_id,
          platform: 'douyin',
        };
      }
      const filename = `${roomTitle}_${timestamp}${ext}`;
      const sanitizedFilename = filename.replace(/[<>:"/\\|?*\n\r]/g, '_');

      await dispatchResource(
        { type: resourceType, url: streamUrl },
        window.electronAPI,
        { filename: sanitizedFilename, videoInfo, platform, options: {} },
      );

      console.log('已添加录制任务到下载管理');
      alert('已添加到下载管理，请前往下载管理查看');

    } catch (err) {
      console.error('录制失败:', err);
      setError(err.message || '录制失败');
    } finally {
      setRecording(false);
    }
  };

  // 获取最佳流地址
  const getBestStreamUrl = () => {
    if (!liveInfo) return null;

    // B 站：直接用 stream_url
    if (liveInfo.isBili) {
      if (!liveInfo.stream_url) return null;
      return {
        type: liveInfo.stream_type || 'FLV',
        url: liveInfo.stream_url,
      };
    }

    // 抖音
    if (!liveInfo.stream_url) return null;
    const streamData = liveInfo.stream_url;

    // 优先顺序: flv_pull_url > hls_pull_url_map > rtmp_pull_url
    if (streamData.flv_pull_url) {
      return {
        type: 'FLV',
        url: Object.values(streamData.flv_pull_url)[0] || Object.values(streamData.flv_pull_url)[0]
      };
    }

    if (streamData.hls_pull_url_map) {
      return {
        type: 'HLS (M3U8)',
        url: Object.values(streamData.hls_pull_url_map)[0] || Object.values(streamData.hls_pull_url_map)[0]
      };
    }

    if (streamData.rtmp_pull_url) {
      return {
        type: 'RTMP',
        url: streamData.rtmp_pull_url
      };
    }

    return null;
  };

  const streamInfo = liveInfo ? getBestStreamUrl() : null;

  return (
    <div className="live-download fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon">🔴</span>
          直播下载
        </h1>
        <p className="hero-subtitle">
          获取直播流地址并录制直播视频
        </p>
      </div>

      {/* 直播信息获取 */}
      <div className="card">
        <h2>🔍 获取直播流</h2>

        {/* 平台切换 */}
        <div className="live-platform-tabs">
          <button
            className={`live-platform-tab${platform === 'douyin' ? ' active' : ''}`}
            onClick={() => { setPlatform('douyin'); setLiveInfo(null); setError(null); setUrl(''); }}
          >抖音直播</button>
          <button
            className={`live-platform-tab${platform === 'bilibili' ? ' active' : ''}`}
            onClick={() => { setPlatform('bilibili'); setLiveInfo(null); setError(null); setUrl(''); }}
          >哔哩哔哩直播</button>
        </div>

        <div className="download-form">
          <div className="input-group">
            <input
              type="text"
              className="form-input url-input"
              placeholder={platform === 'bilibili'
                ? '粘贴 B 站直播间链接，例如 https://live.bilibili.com/9490654'
                : '粘贴直播间链接或 webRid...'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleFetchLive()}
            />
            <button
              className="btn btn-primary"
              onClick={handleFetchLive}
              disabled={loading || !url.trim() || !pythonRunning}
            >
              {loading ? (
                <>
                  <span className="loading-spinner"></span>
                  获取中...
                </>
              ) : (
                <>
                  <span>📡</span>
                  获取直播流
                </>
              )}
            </button>
          </div>

          <div className="tips">
            <span>💡</span>
            <span>支持直播间链接或直接输入 webRid / room_id</span>
          </div>
        </div>

        {error && (
          <div className="alert alert-danger">
            ❌ {error}
          </div>
        )}

        {liveInfo && (
          <div className="live-info-section">
            <h3>✓ 直播间信息</h3>

            {/* 主播信息 */}
            <div className="live-info-card">
              <div className="live-cover">
                {liveInfo.isBili ? (
                  <div className="live-cover-placeholder">📺</div>
                ) : (
                  <>
                    {liveInfo.cover?.url_list?.[0] && (
                      <img src={liveInfo.cover.url_list[0]} alt="直播间封面" />
                    )}
                    <div className="live-status-badge">
                      {liveInfo.status === 2 ? '直播中' : '回放'}
                    </div>
                  </>
                )}
              </div>
              <div className="live-details">
                <h4>{liveInfo.title || '无标题'}</h4>
                {liveInfo.isBili ? (
                  <>
                    <p>主播: {liveInfo.uname || 'B站直播间'}</p>
                    <p>Room ID: {liveInfo.room_id}{liveInfo.short_id && liveInfo.short_id !== String(liveInfo.room_id) ? `（短号 ${liveInfo.short_id}）` : ''}</p>
                    <p>状态: {liveInfo.live_status === 1 ? '🟢 直播中' : liveInfo.live_status === 2 ? '🟡 轮播中' : '⚪ 未开播'}</p>
                  </>
                ) : (
                  <>
                    <p>主播: {liveInfo.owner?.nickname || '未知'}</p>
                    <p>观众: {liveInfo.stats?.total_user_str || '0'}</p>
                    <p>Room ID: {liveInfo.room_id}</p>
                  </>
                )}
              </div>
            </div>

            {/* 流地址信息 */}
            {streamInfo && (
              <div className="stream-info-card">
                <h4>📺 直播流地址</h4>
                <div className="stream-type">
                  <span className="stream-badge">{streamInfo.type}</span>
                </div>
                <div className="stream-url-box">
                  <input
                    type="text"
                    className="stream-url-input"
                    value={streamInfo.url}
                    readOnly
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => copyToClipboard(streamInfo.url)}
                  >
                    复制
                  </button>
                </div>

                <div className="stream-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => handleStartRecording(streamInfo)}
                    disabled={recording}
                  >
                    {recording ? '录制中...' : '📥 开始录制'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => window.open(streamInfo.url, '_blank')}
                  >
                    🎬 在浏览器播放
                  </button>
                </div>

                <div className="tips" style={{ marginTop: '15px' }}>
                  <span>💡</span>
                  <span>提示: 可以复制流地址到 VLC、PotPlayer 等播放器观看或录制</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 使用说明 */}
      <div className="card">
        <h2>📖 使用说明</h2>
        <div className="instructions">
          <div className="instruction-item">
            <span className="instruction-number">1</span>
            <div className="instruction-content">
              <h4>获取直播间链接</h4>
              <p>在抖音APP中进入直播间，点击分享，复制链接</p>
            </div>
          </div>
          <div className="instruction-item">
            <span className="instruction-number">2</span>
            <div className="instruction-content">
              <h4>获取直播流地址</h4>
              <p>将链接粘贴到上方输入框，点击"获取直播流"按钮</p>
            </div>
          </div>
          <div className="instruction-item">
            <span className="instruction-number">3</span>
            <div className="instruction-content">
              <h4>录制或播放</h4>
              <p>点击"开始录制"自动录制，或复制地址到播放器中播放</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LiveDownload;
