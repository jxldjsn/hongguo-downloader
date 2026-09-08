import React, { useState } from 'react';
import api from '../utils/api';
import './CommentDownload.css';

function CommentDownload({ pythonRunning = false }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);

  // 解析视频并下载评论
  const handleDownloadComments = async () => {
    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }

    if (!url.trim()) {
      setError('请输入有效的视频链接或ID');
      return;
    }

    setLoading(true);
    setError(null);
    setVideoInfo(null);

    try {
      // 1. 解析链接获取视频ID
      let awemeId = null;

      // 如果是完整链接，先解析
      if (url.includes('douyin.com') || url.includes('v.douyin.com')) {
        // 先尝试从原始URL中提取
        const directMatch = url.match(/video\/(\d+)/);
        if (directMatch) {
          awemeId = directMatch[1];
          console.log('从原始URL提取到 aweme_id:', awemeId);
        } else {
          // 如果原始URL中没有，尝试解析短链接
          try {
            const resolved = await api.resolveShareLink(url);
            console.log('解析后的链接:', resolved);

            // 检查resolved是否有效
            if (resolved && typeof resolved === 'string') {
              const match = resolved.match(/video\/(\d+)/);
              if (match) {
                awemeId = match[1];
                console.log('从解析后URL提取到 aweme_id:', awemeId);
              }
            } else {
              // 如果解析失败，尝试从原始URL的其他模式提取
              const modalMatch = url.match(/modal_id=(\d+)/);
              if (modalMatch) {
                awemeId = modalMatch[1];
                console.log('从modal_id提取到 aweme_id:', awemeId);
              }
            }
          } catch (err) {
            console.warn('链接解析失败，尝试其他方式:', err);
            // 尝试从URL的其他部分提取
            const modalMatch = url.match(/modal_id=(\d+)/);
            if (modalMatch) {
              awemeId = modalMatch[1];
              console.log('从modal_id提取到 aweme_id:', awemeId);
            }
          }
        }
      } else {
        // 直接输入的可能是 aweme_id
        awemeId = url.trim();
      }

      if (!awemeId) {
        throw new Error('无法从链接中提取视频ID，请检查链接格式');
      }

      console.log('最终使用的 aweme_id:', awemeId);

      // 2. 获取视频信息
      const videoDetail = await api.getVideoDetail(awemeId);
      console.log('视频信息:', videoDetail);

      if (!videoDetail || !videoDetail.aweme_detail) {
        throw new Error('获取视频信息失败，请检查链接是否正确或登录状态');
      }

      const awemeDetail = videoDetail.aweme_detail;
      setVideoInfo({
        awemeId,
        title: awemeDetail.desc || '无标题',
        author: awemeDetail.author?.nickname || '未知',
        commentCount: awemeDetail.statistics?.comment_count || 0,
      });

      // 3. 开始下载评论
      const result = await window.electronAPI.downloadComments(awemeId, awemeDetail.desc);

      if (result.success) {
        console.log('评论下载任务已添加到下载管理');
      } else {
        throw new Error(result.error || '添加下载任务失败');
      }

    } catch (err) {
      console.error('下载评论失败:', err);
      setError(err.message || '下载评论失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="comment-download fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon">💬</span>
          评论下载
        </h1>
        <p className="hero-subtitle">
          下载抖音视频的所有评论数据，导出为CSV格式
        </p>
      </div>

      {/* 评论下载 */}
      <div className="card">
        <h2>🔍 下载视频评论</h2>
        <div className="download-form">
          <div className="input-group">
            <input
              type="text"
              className="form-input url-input"
              placeholder="粘贴视频链接或 aweme_id..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleDownloadComments()}
            />
            <button
              className="btn btn-primary"
              onClick={handleDownloadComments}
              disabled={loading || !url.trim() || !pythonRunning}
            >
              {loading ? (
                <>
                  <span className="loading-spinner"></span>
                  下载中...
                </>
              ) : (
                <>
                  <span>📥</span>
                  下载评论
                </>
              )}
            </button>
          </div>

          <div className="tips">
            <span>💡</span>
            <span>支持视频链接或直接输入 aweme_id，评论将保存为CSV文件</span>
          </div>
        </div>

        {error && (
          <div className="alert alert-danger">
            ❌ {error}
          </div>
        )}

        {videoInfo && (
          <div className="video-info-section">
            <h3>✓ 视频信息</h3>
            <div className="video-info-card">
              <div className="video-details">
                <p><strong>标题:</strong> {videoInfo.title}</p>
                <p><strong>作者:</strong> {videoInfo.author}</p>
                <p><strong>评论数:</strong> {videoInfo.commentCount}</p>
                <p className="success-message">✓ 评论下载任务已添加到下载管理，请前往下载管理查看进度</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 使用说明 */}
      <div className="card">
        <h2>📖 使用说明</h2>
        <div className="instructions">
          <ol>
            <li>在抖音APP或网页复制视频链接</li>
            <li>将链接粘贴到上方输入框</li>
            <li>点击"下载评论"按钮</li>
            <li>系统会自动获取所有评论并保存为CSV文件</li>
            <li>前往"下载管理"页面查看下载进度</li>
            <li>下载完成后可使用Excel或其他工具打开CSV文件</li>
          </ol>

          <div className="csv-format-info">
            <h4>CSV文件包含以下字段：</h4>
            <ul>
              <li>评论ID</li>
              <li>用户昵称</li>
              <li>抖音号</li>
              <li>评论内容</li>
              <li>点赞数</li>
              <li>回复数</li>
              <li>发布时间</li>
              <li>IP属地</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CommentDownload;
