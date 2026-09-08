/**
 * Native API Wrapper for Douyin
 * Uses native Node.js implementation via Electron IPC
 */

class DouyinAPI {
  constructor() {
    this.platform = 'douyin';
  }

  async request(method, params = {}) {
    const result = await window.electronAPI.nativeAPI(this.platform, method, params);
    if (!result.success) {
      throw new Error(result.error || 'API request failed');
    }
    return result.data;
  }

  // ========== 抖音API ==========

  // 解析分享链接
  async resolveShareLink(url) {
    return this.request('resolveShareLink', { url });
  }

  // 获取作品详情
  async getVideoDetail(detailId, options = {}) {
    return this.request('getVideoDetail', { id: detailId });
  }

  // 获取账号作品
  async getAccountVideos(secUserId, options = {}) {
    return this.request('getUserVideos', {
      secUserId,
      cursor: options.cursor || 0,
      count: options.count || 18
    });
  }

  // 获取合集作品
  async getMixVideos(mixId = '', detailId = '', options = {}) {
    return this.request('getMixVideos', {
      mixId,
      cursor: options.cursor || 0,
      count: options.count || 20
    });
  }

  // 获取直播信息
  async getLiveStream(webRid, options = {}) {
    return this.request('getLiveStream', { webRid });
  }

  // 获取评论
  async getComments(detailId, options = {}) {
    return this.request('getVideoComments', {
      awemeId: detailId,
      cursor: options.cursor || 0,
      count: options.count || 20
    });
  }

  // 获取评论回复
  async getCommentReplies(detailId, commentId, options = {}) {
    // Not implemented in native API yet
    throw new Error('Comment replies not implemented in native API');
  }

  // 综合搜索
  async searchGeneral(keyword, options = {}) {
    return this.searchVideos(keyword, options);
  }

  // 搜索视频
  async searchVideos(keyword, options = {}) {
    return this.request('searchVideos', {
      keyword,
      offset: options.offset || 0,
      count: options.count || 20
    });
  }

  // 搜索用户
  async searchUsers(keyword, options = {}) {
    return this.request('searchUsers', {
      keyword,
      offset: options.offset || 0,
      count: options.count || 20
    });
  }

  // 搜索直播
  async searchLive(keyword, options = {}) {
    // Not implemented in native API yet
    throw new Error('Live search not implemented in native API');
  }

  // 获取用户主页
  async getUserProfile(secUserId) {
    return this.request('getUserProfile', { secUserId });
  }

  // 获取用户发布的作品
  async getUserVideos(secUserId, cursor = 0, count = 20) {
    return this.request('getUserVideos', {
      secUserId,
      cursor,
      count
    });
  }

  // 获取用户喜欢的作品
  async getUserLikedVideos(secUserId, cursor = 0, count = 20) {
    return this.request('getUserLikedVideos', {
      secUserId,
      cursor,
      count
    });
  }

  // 获取用户收藏的作品
  async getUserCollections(secUserId, cursor = 0, count = 20) {
    return this.request('getUserCollections', {
      secUserId,
      cursor,
      count
    });
  }

  // 获取热榜
  async getHotBoard(boardType = 1) {
    return this.request('getHotBoard', { boardType });
  }

  // ========== 设置API ==========

  async getSettings() {
    // 从主进程读取持久化设置
    if (window.electronAPI && window.electronAPI.getSettings) {
      return await window.electronAPI.getSettings();
    }
    return {
      root: '',
      folder_name: '',
      name_format: '标题 作品ID',
      proxy: '',
    };
  }

  async updateSettings(settings) {
    // 持久化保存到主进程
    if (window.electronAPI && window.electronAPI.saveSettings) {
      return await window.electronAPI.saveSettings(settings);
    }
    return { success: true };
  }
}

// 创建单例
const api = new DouyinAPI();

export default api;

// 导出便捷方法时保留实例 this；直接解构方法会让 this 变成 undefined。
export const resolveShareLink = (...args) => api.resolveShareLink(...args);
export const getVideoDetail = (...args) => api.getVideoDetail(...args);
export const getAccountVideos = (...args) => api.getAccountVideos(...args);
export const getMixVideos = (...args) => api.getMixVideos(...args);
export const getLiveStream = (...args) => api.getLiveStream(...args);
export const getComments = (...args) => api.getComments(...args);
export const getCommentReplies = (...args) => api.getCommentReplies(...args);
export const searchGeneral = (...args) => api.searchGeneral(...args);
export const searchVideos = (...args) => api.searchVideos(...args);
export const searchUsers = (...args) => api.searchUsers(...args);
export const searchLive = (...args) => api.searchLive(...args);
export const getUserProfile = (...args) => api.getUserProfile(...args);
export const getUserVideos = (...args) => api.getUserVideos(...args);
export const getUserLikedVideos = (...args) => api.getUserLikedVideos(...args);
export const getUserCollections = (...args) => api.getUserCollections(...args);
export const getHotBoard = (...args) => api.getHotBoard(...args);
export const getSettings = (...args) => api.getSettings(...args);
export const updateSettings = (...args) => api.updateSettings(...args);
