'use strict';

const PAYLOAD_VERSION = 1;
const GENERIC_FIELDS = Object.freeze(['headers']);

const FIELDS_BY_TYPE = Object.freeze({
  file: GENERIC_FIELDS,
  album: Object.freeze(['albumItems', 'albumFolderName', 'failedAlbumItems', 'headers']),
  dash: Object.freeze(['dashVideoUrl', 'dashAudioUrl', 'headers']),
  m3u8: Object.freeze(['m3u8Url', 'headers']),
  mpd: Object.freeze(['mpdUrl', 'headers']),
  ytdl: Object.freeze(['ytdlUrl', 'ytdlMaxHeight']),
  hongguo: Object.freeze(['hongguoInfo', 'headers']),
});

const RUNTIME_FIELDS = new Set([
  'cancelSource',
  'writer',
  'responseStream',
  'childProcess',
  'runtime',
  'ytdlProcess',
]);
const OMIT = Symbol('omit');

function cloneSerializable(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'function' || typeof value === 'undefined'
    || typeof value === 'symbol' || typeof value === 'bigint') return OMIT;
  if (typeof value !== 'object') return OMIT;
  if (ancestors.has(value)) return OMIT;

  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) {
      const cloned = cloneSerializable(item, ancestors);
      if (cloned !== OMIT) result.push(cloned);
    }
    ancestors.delete(value);
    return result;
  }

  const result = {};
  for (const key of Object.keys(value)) {
    if (RUNTIME_FIELDS.has(key)) continue;
    let fieldValue;
    try {
      fieldValue = value[key];
    } catch (_) {
      continue;
    }
    const cloned = cloneSerializable(fieldValue, ancestors);
    if (cloned !== OMIT) {
      Object.defineProperty(result, key, {
        value: cloned,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  ancestors.delete(value);
  return result;
}

function buildTaskPayload(task) {
  const source = task && typeof task === 'object' ? task : {};
  const type = typeof source.type === 'string' && source.type.length > 0
    ? source.type
    : 'file';
  const fields = FIELDS_BY_TYPE[type] || GENERIC_FIELDS;
  const data = {};

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const cloned = cloneSerializable(source[field]);
    if (cloned !== OMIT) data[field] = cloned;
  }

  return { version: PAYLOAD_VERSION, type, data };
}

function validEnvelope(payload) {
  return !!payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && payload.version === PAYLOAD_VERSION
    && typeof payload.type === 'string'
    && payload.type.length > 0
    && !!payload.data
    && typeof payload.data === 'object'
    && !Array.isArray(payload.data);
}

function applyTaskPayload(base, payload) {
  const result = base && typeof base === 'object' ? { ...base } : {};
  if (!validEnvelope(payload)) return result;
  if (typeof result.type === 'string' && result.type && result.type !== payload.type) return result;

  const fields = FIELDS_BY_TYPE[payload.type] || GENERIC_FIELDS;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload.data, field)) continue;
    const cloned = cloneSerializable(payload.data[field]);
    if (cloned !== OMIT) result[field] = cloned;
  }
  return result;
}

function invalid(error) {
  return { valid: false, error };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateTaskPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('任务载荷结构无效');
  }
  if (payload.version !== PAYLOAD_VERSION) return invalid('任务载荷版本不受支持');
  if (typeof payload.type !== 'string' || payload.type.length === 0) return invalid('任务载荷类型无效');
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return invalid('任务载荷数据无效');
  }

  const data = payload.data;
  switch (payload.type) {
    case 'album':
      if (!Array.isArray(data.albumItems) || data.albumItems.length === 0) {
        return invalid('图集任务缺少下载项目');
      }
      if (Object.prototype.hasOwnProperty.call(data, 'failedAlbumItems')
        && !Array.isArray(data.failedAlbumItems)) {
        return invalid('图集失败项目结构无效');
      }
      break;
    case 'dash':
      if (!isNonEmptyString(data.dashVideoUrl) || !isNonEmptyString(data.dashAudioUrl)) {
        return invalid('DASH 任务缺少音视频地址');
      }
      break;
    case 'm3u8':
      if (!isNonEmptyString(data.m3u8Url)) return invalid('m3u8 任务缺少清单地址');
      break;
    case 'mpd':
      if (!isNonEmptyString(data.mpdUrl)) return invalid('MPD 任务缺少清单地址');
      break;
    case 'ytdl':
      if (!isNonEmptyString(data.ytdlUrl)) return invalid('yt-dlp 任务缺少来源地址');
      if (Object.prototype.hasOwnProperty.call(data, 'ytdlMaxHeight')
        && (!Number.isFinite(data.ytdlMaxHeight) || data.ytdlMaxHeight < 0)) {
        return invalid('yt-dlp 最大高度无效');
      }
      break;
    case 'hongguo':
      if (!data.hongguoInfo || typeof data.hongguoInfo !== 'object'
        || Array.isArray(data.hongguoInfo)
        || !Object.prototype.hasOwnProperty.call(data.hongguoInfo, 'vid')
        || !data.hongguoInfo.vid) {
        return invalid('红果任务缺少视频标识');
      }
      break;
    default:
      break;
  }

  return { valid: true };
}

module.exports = {
  PAYLOAD_VERSION,
  FIELDS_BY_TYPE,
  buildTaskPayload,
  applyTaskPayload,
  validateTaskPayload,
};
