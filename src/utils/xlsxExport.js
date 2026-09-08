/**
 * 主页作品数据导出为 xlsx（Excel）文件。
 * 工作簿由 ExcelJS 生成，所有单元格只写入净化后的字符串、数字或日期。
 */
import { isImageWork } from './douyinWork';
import { buildWorkbookBuffer } from './xlsxWorkbook.mjs';

const EXPORT_COLUMNS = [
  { header: '序号', key: '序号', width: 6 },
  { header: '类型', key: '类型', width: 8 },
  { header: '发布时间', key: '发布时间', width: 20 },
  { header: '文案', key: '文案', width: 50 },
  { header: '合集', key: '合集', width: 18 },
  { header: '播放量', key: '播放量', width: 12 },
  { header: '点赞数', key: '点赞数', width: 10 },
  { header: '评论数', key: '评论数', width: 10 },
  { header: '收藏数', key: '收藏数', width: 10 },
  { header: '分享数', key: '分享数', width: 10 },
  { header: '推荐此书', key: '推荐此书', width: 16 },
  { header: '视频时长', key: '视频时长', width: 12 },
  { header: '作品链接', key: '作品链接', width: 50 },
];

function fmtTime(sec) {
  const value = Number(sec);
  if (!value || value <= 0) return '';
  return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms) {
  const seconds = Math.round(Number(ms) / 1000) || 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function getMixName(video) {
  if (video?.mix_info) {
    return video.mix_info.mix_name || video.mix_info.stamina?.mix_desc || '';
  }
  if (Array.isArray(video?.cha_list)) {
    return video.cha_list.map(item => item?.cha_name).filter(Boolean).join('、');
  }
  return '';
}

function getRecommendBook(video) {
  if (Array.isArray(video?.text_extra)) {
    const names = video.text_extra
      .filter(item => item && (item.type === 1 || item.hashtag_name) && item.hashtag_name)
      .map(item => item.hashtag_name)
      .filter(name => /书|小说|文|推|读|章|篇/.test(name));
    if (names.length > 0) return names.join('、');
  }
  if (Array.isArray(video?.interaction_labels)) {
    return video.interaction_labels
      .map(item => item?.label_name || item)
      .filter(Boolean)
      .join('、');
  }
  return '';
}

export function videosToExportRows(videos, authorName = '') {
  void authorName;
  if (!Array.isArray(videos)) return [];
  return videos.map((video, index) => {
    const statistics = video?.statistics || {};
    const imageWork = isImageWork(video);
    return {
      '序号': index + 1,
      '类型': imageWork ? '图集' : '视频',
      '发布时间': fmtTime(video?.create_time),
      '文案': video?.desc || '',
      '合集': getMixName(video),
      '播放量': statistics.play_count ?? 0,
      '点赞数': statistics.digg_count ?? 0,
      '评论数': statistics.comment_count ?? 0,
      '收藏数': statistics.collect_count ?? 0,
      '分享数': statistics.share_count ?? 0,
      '推荐此书': getRecommendBook(video),
      '视频时长': imageWork ? '' : fmtDuration(video?.video?.duration),
      '作品链接': video?.share_url || '',
    };
  });
}

export async function buildXlsx(rows) {
  return buildWorkbookBuffer(rows, {
    sheetName: '作品数据',
    columns: EXPORT_COLUMNS,
  });
}

export function downloadXlsx(buffer, filename) {
  const blob = new Blob(
    [buffer],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

export async function exportVideosToXlsx(videos, authorName = '') {
  const rows = videosToExportRows(videos, authorName);
  const buffer = await buildXlsx(rows);
  const safeName = (authorName || '主页作品').replace(/[<>:"/\\|?*\n\r]/g, '_').slice(0, 30);
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  downloadXlsx(buffer, `${safeName}_作品数据_${timestamp}.xlsx`);
}

