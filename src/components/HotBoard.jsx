import React, { useState, useEffect } from 'react';
import api from '../utils/api';
import { exportHotBoardToCSV, downloadCSV } from '../utils/csvExport';
import './HotBoard.css';

function HotBoard({ pythonRunning = false }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hotList, setHotList] = useState([]);
  const [selectedBoard, setSelectedBoard] = useState(1);

  useEffect(() => {
    handleFetchHotBoard(selectedBoard);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const boardTypes = [
    { value: 1, label: '抖音热榜', icon: '🔥' },
    { value: 2, label: '娱乐榜', icon: '🎬' },
    { value: 3, label: '社会榜', icon: '📰' },
    { value: 4, label: '挑战榜', icon: '🏆' },
  ];

  // 获取热榜数据
  const handleFetchHotBoard = async (boardType) => {
    if (!pythonRunning) {
      setError('后端未运行，请先启动应用');
      return;
    }

    setLoading(true);
    setError(null);
    setHotList([]);

    try {
      const result = await api.getHotBoard(boardType);
      console.log('热榜数据:', result);
      console.log('data字段:', result.data);

      if (!result || !result.data) {
        throw new Error('获取热榜数据失败');
      }

      // 检查不同可能的数据结构
      let wordList = null;

      if (result.data.word_list) {
        wordList = result.data.word_list;
      } else if (result.data.data && result.data.data.word_list) {
        wordList = result.data.data.word_list;
      } else if (Array.isArray(result.data)) {
        wordList = result.data;
      }

      console.log('提取到的word_list:', wordList);

      if (!wordList || wordList.length === 0) {
        throw new Error('热榜数据为空，可能该榜单暂无数据');
      }

      const formattedList = wordList.map((item, index) => ({
        position: item.position || index + 1,
        word: item.word || '',
        hot_value: item.hot_value || 0,
        label: item.label || '',
        event_time: item.event_time || 0,
      }));

      setHotList(formattedList);

    } catch (err) {
      console.error('获取热榜失败:', err);
      setError(err.message || '获取热榜失败');
    } finally {
      setLoading(false);
    }
  };

  // 导出为CSV
  const handleExportCSV = () => {
    if (hotList.length === 0) {
      setError('没有可导出的数据');
      return;
    }

    try {
      const csvContent = exportHotBoardToCSV(hotList);
      const boardLabel = boardTypes.find(b => b.value === selectedBoard)?.label || '热榜';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
      const filename = `${boardLabel}_${timestamp}.csv`;

      downloadCSV(csvContent, filename);

      console.log('热榜数据已导出:', filename);
    } catch (err) {
      console.error('导出失败:', err);
      setError(err.message || '导出失败');
    }
  };

  // 复制到剪贴板
  const handleCopyKeywords = () => {
    if (hotList.length === 0) {
      setError('没有可复制的数据');
      return;
    }

    try {
      const keywords = hotList.map(item => item.word).join('\n');
      navigator.clipboard.writeText(keywords);
      console.log('关键词已复制到剪贴板');
    } catch (err) {
      console.error('复制失败:', err);
      setError(err.message || '复制失败');
    }
  };

  // 选择榜单类型
  const handleSelectBoard = (boardType) => {
    setSelectedBoard(boardType);
    handleFetchHotBoard(boardType);
  };

  // 格式化热度值
  const formatHotValue = (value) => {
    if (value >= 100000000) {
      return (value / 100000000).toFixed(2) + '亿';
    } else if (value >= 10000) {
      return (value / 10000).toFixed(2) + '万';
    }
    return value;
  };

  return (
    <div className="hot-board fade-in">
      <div className="hero-section">
        <h1 className="hero-title">
          <span className="hero-title-icon">🔥</span>
          抖音热榜
        </h1>
        <p className="hero-subtitle">
          查看抖音实时热榜数据，支持导出为CSV格式
        </p>
      </div>

      {/* 榜单类型选择 */}
      <div className="card">
        <h2>📊 选择榜单</h2>
        <div className="board-type-grid">
          {boardTypes.map(board => (
            <button
              key={board.value}
              className={`board-type-card ${selectedBoard === board.value ? 'board-type-active' : ''}`}
              onClick={() => handleSelectBoard(board.value)}
              disabled={loading}
            >
              <div className="board-icon">{board.icon}</div>
              <div className="board-label">{board.label}</div>
            </button>
          ))}
        </div>

        {loading && (
          <div className="loading-indicator">
            <span className="loading-spinner"></span>
            <span>加载中...</span>
          </div>
        )}

        {error && (
          <div className="alert alert-danger">
            ❌ {error}
          </div>
        )}
      </div>

      {/* 热榜列表 */}
      {hotList.length > 0 && (
        <div className="card">
          <div className="hotlist-header">
            <h2>📋 热榜列表 ({hotList.length}条)</h2>
            <div className="hotlist-actions">
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCopyKeywords}
              >
                📋 复制关键词
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleExportCSV}
              >
                📥 导出CSV
              </button>
            </div>
          </div>

          <div className="hotlist-table-wrapper">
            <table className="hotlist-table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>关键词</th>
                  <th>热度</th>
                  <th>标签</th>
                </tr>
              </thead>
              <tbody>
                {hotList.map((item, index) => (
                  <tr key={index}>
                    <td className="rank-cell">
                      <span className={`rank-badge rank-${item.position <= 3 ? item.position : 'other'}`}>
                        {item.position}
                      </span>
                    </td>
                    <td className="keyword-cell">{item.word}</td>
                    <td className="hotvalue-cell">{formatHotValue(item.hot_value)}</td>
                    <td className="label-cell">
                      {item.label && (
                        <span className="label-tag">{item.label}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 使用说明 */}
      <div className="card">
        <h2>📖 使用说明</h2>
        <div className="instructions">
          <ol>
            <li>选择要查看的榜单类型（抖音热榜、娱乐榜、社会榜、挑战榜）</li>
            <li>系统会自动获取最新的热榜数据</li>
            <li>可以点击"导出CSV"将数据保存到本地</li>
            <li>可以点击"复制关键词"快速复制所有关键词</li>
            <li>CSV文件可以使用Excel或其他工具打开</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

export default HotBoard;
