/**
 * CSV Export Utility
 * Handles conversion of data to CSV format
 */

/**
 * Convert array of objects to CSV string
 * @param {Array} data - Array of objects to convert
 * @param {Array} headers - Array of header objects {key, label}
 * @returns {string} CSV formatted string
 */
export function arrayToCSV(data, headers) {
  if (!data || data.length === 0) {
    return '';
  }

  // Create header row
  const headerRow = headers.map(h => escapeCSVValue(sanitizeSpreadsheetCell(h.label))).join(',');

  // Create data rows
  const dataRows = data.map(row => {
    return headers.map(h => {
      const value = getNestedValue(row, h.key);
      return escapeCSVValue(sanitizeSpreadsheetCell(value));
    }).join(',');
  });

  return [headerRow, ...dataRows].join('\n');
}

/**
 * Get nested object value by dot notation path
 * @param {Object} obj - Object to get value from
 * @param {string} path - Dot notation path (e.g., 'user.nickname')
 * @returns {any} Value at path
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : '';
  }, obj);
}

/**
 * Prevent spreadsheet applications from interpreting exported text as a formula.
 * Numbers and dates remain typed values; only dangerous string prefixes are escaped.
 */
export function sanitizeSpreadsheetCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
}

/**
 * Escape CSV value (handle commas, quotes, newlines)
 * @param {any} value - Value to escape
 * @returns {string} Escaped value
 */
function escapeCSVValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  // If value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return '"' + stringValue.replace(/"/g, '""') + '"';
  }

  return stringValue;
}

/**
 * Export comments to CSV format
 * @param {Array} comments - Array of comment objects
 * @returns {string} CSV formatted string
 */
export function exportCommentsToCSV(comments) {
  const headers = [
    { key: 'cid', label: '评论ID' },
    { key: 'user.nickname', label: '用户昵称' },
    { key: 'user.unique_id', label: '抖音号' },
    { key: 'text', label: '评论内容' },
    { key: 'digg_count', label: '点赞数' },
    { key: 'reply_comment_total', label: '回复数' },
    { key: 'create_time', label: '发布时间' },
    { key: 'ip_label', label: 'IP属地' },
  ];

  return arrayToCSV(comments, headers);
}

/**
 * Export user statistics to CSV format
 * @param {Object} userStats - User statistics object
 * @returns {string} CSV formatted string
 */
export function exportUserStatsToCSV(userStats) {
  const data = [{
    nickname: userStats.nickname || '',
    unique_id: userStats.unique_id || '',
    follower_count: userStats.follower_count || 0,
    following_count: userStats.following_count || 0,
    total_favorited: userStats.total_favorited || 0,
    aweme_count: userStats.aweme_count || 0,
    favoriting_count: userStats.favoriting_count || 0,
    signature: userStats.signature || '',
  }];

  const headers = [
    { key: 'nickname', label: '昵称' },
    { key: 'unique_id', label: '抖音号' },
    { key: 'follower_count', label: '粉丝数' },
    { key: 'following_count', label: '关注数' },
    { key: 'total_favorited', label: '获赞数' },
    { key: 'aweme_count', label: '作品数' },
    { key: 'favoriting_count', label: '喜欢数' },
    { key: 'signature', label: '个性签名' },
  ];

  return arrayToCSV(data, headers);
}

/**
 * Export video statistics to CSV format
 * @param {Array} videos - Array of video objects
 * @returns {string} CSV formatted string
 */
export function exportVideoStatsToCSV(videos) {
  const headers = [
    { key: 'aweme_id', label: '视频ID' },
    { key: 'desc', label: '标题' },
    { key: 'author.nickname', label: '作者' },
    { key: 'statistics.digg_count', label: '点赞数' },
    { key: 'statistics.comment_count', label: '评论数' },
    { key: 'statistics.share_count', label: '分享数' },
    { key: 'statistics.collect_count', label: '收藏数' },
    { key: 'statistics.play_count', label: '播放数' },
    { key: 'create_time', label: '发布时间' },
  ];

  return arrayToCSV(videos, headers);
}

/**
 * Export hot board data to CSV format
 * @param {Array} hotList - Array of hot board items
 * @returns {string} CSV formatted string
 */
export function exportHotBoardToCSV(hotList) {
  const headers = [
    { key: 'position', label: '排名' },
    { key: 'word', label: '关键词' },
    { key: 'hot_value', label: '热度值' },
    { key: 'label', label: '标签' },
  ];

  return arrayToCSV(hotList, headers);
}

/**
 * Download CSV file
 * @param {string} csvContent - CSV content string
 * @param {string} filename - Filename for download
 */
export function downloadCSV(csvContent, filename) {
  // Add BOM for Excel to recognize UTF-8
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });

  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}
