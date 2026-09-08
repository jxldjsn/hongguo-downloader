const RESOURCE_SPECIFICITY = Object.freeze({
  m3u8_seg: 0,
  video: 1,
  audio: 1,
  image: 1,
  video_dash: 2,
  audio_dash: 2,
  m3u8: 3,
  dash: 3,
});

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped', 'partial']);

export function successfulIndices(results) {
  const accepted = new Set();
  if (!Array.isArray(results)) return accepted;
  results.forEach((result, index) => {
    if (result?.success === true) accepted.add(index);
  });
  return accepted;
}

export function aggregateBatch(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return 'pending';
  const statuses = list.map(task => task?.status || 'pending');

  if (statuses.some(status => status === 'downloading' || status === 'pending')) return 'downloading';
  if (statuses.some(status => status === 'parsing')) return 'parsing';

  const completed = statuses.filter(status => status === 'completed').length;
  const partial = statuses.filter(status => status === 'partial').length;
  const failed = statuses.filter(status => status === 'failed').length;
  const stopped = statuses.filter(status => status === 'stopped').length;

  if (partial > 0 || (completed > 0 && (failed > 0 || stopped > 0))) return 'partial';
  if (failed > 0) return 'failed';
  if (stopped > 0) return 'stopped';
  if (completed === statuses.length) return 'completed';
  return 'failed';
}

function revisionOf(task) {
  return Number.isSafeInteger(task?.revision) && task.revision >= 0 ? task.revision : 0;
}

function hasRevision(task) {
  return Number.isSafeInteger(task?.revision) && task.revision >= 0;
}

export function mergeTaskEvent(tasks, event) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!event || typeof event !== 'object' || !event.id) return list;
  const index = list.findIndex(task => task?.id === event.id);
  if (index === -1) return [...list, { ...event }];

  const current = list[index];
  const incomingHasRevision = hasRevision(event);
  if (incomingHasRevision && revisionOf(event) < revisionOf(current)) return list;
  if (!incomingHasRevision
      && TERMINAL_TASK_STATUSES.has(current.status)
      && !TERMINAL_TASK_STATUSES.has(event.status)) {
    return list;
  }
  const next = [...list];
  next[index] = {
    ...current,
    ...event,
    revision: incomingHasRevision ? event.revision : revisionOf(current),
  };
  return next;
}

export function upsertResource(resources, resource) {
  const list = Array.isArray(resources) ? resources : [];
  if (!resource || typeof resource !== 'object' || !resource.url) return list;
  const index = list.findIndex(item => item?.url === resource.url);
  if (index === -1) return [...list, { ...resource }];

  const currentRank = RESOURCE_SPECIFICITY[list[index]?.type] ?? -1;
  const incomingRank = RESOURCE_SPECIFICITY[resource.type] ?? -1;
  if (incomingRank < currentRank) return list;
  const next = [...list];
  next[index] = { ...resource };
  return next;
}

export function resourceAction(resource) {
  switch (resource?.type) {
    case 'm3u8': return 'downloadM3u8';
    case 'dash': return 'downloadMpd';
    case 'video_dash':
    case 'audio_dash':
    case 'm3u8_seg':
    case 'video':
    case 'image':
    case 'audio':
      return 'downloadFile';
    case 'rtmp': return 'recordWithFfmpeg';
    default: throw new Error(`不支持的资源类型: ${resource?.type || 'unknown'}`);
  }
}

export async function dispatchResource(resource, electronAPI, config = {}) {
  if (!electronAPI || typeof electronAPI !== 'object') {
    throw new Error('下载接口不可用');
  }
  const action = resourceAction(resource);
  const filename = config.filename || 'resource.bin';
  const videoInfo = config.videoInfo || {};
  const platform = config.platform || 'generic';
  const options = config.options || {};

  let result;
  if (action === 'downloadM3u8') {
    result = await electronAPI.downloadM3u8(resource.url, videoInfo, platform, options);
  } else if (action === 'downloadMpd') {
    result = await electronAPI.downloadMpd(resource.url, videoInfo, platform, options);
  } else if (action === 'recordWithFfmpeg') {
    result = await electronAPI.recordLiveStream(resource.url, filename, videoInfo, platform, options);
  } else {
    result = await electronAPI.downloadFile(resource.url, filename, videoInfo, platform, options);
  }

  if (result?.success === false) {
    throw new Error(result.error || '任务未能加入下载队列');
  }
  return result;
}

export { RESOURCE_SPECIFICITY };
