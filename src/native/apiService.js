/**
 * Native API Service for Douyin
 * Replaces Python backend with native Node.js implementation
 */

const axios = require('axios');
const { ABogus, USERAGENT } = require('./encrypt/aBogus');
const { XBogus } = require('./encrypt/xBogus');

const DOUYIN_DOMAIN = 'https://www.douyin.com/';
const TIKTOK_DOMAIN = 'https://www.tiktok.com/';

class DouyinAPI {
  constructor(cookie = '', proxy = null, options = {}) {
    this.cookie = cookie;
    this.proxy = proxy;
    // 请求超时（秒→毫秒）与最大重试次数，来自用户设置
    this.timeout = (Number(options.timeout) > 0 ? Number(options.timeout) : 10) * 1000;
    this.maxRetry = Number.isInteger(options.maxRetry) && options.maxRetry >= 0 ? options.maxRetry : 5;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
    this.aBogus = new ABogus(this.userAgent);

    // 签名参数（首次请求时尝试从官方接口获取真实值，失败则使用本地伪造值）
    this.webid = this.generateWebId();
    this.msToken = this.generateMsToken();
    this.ttwid = null;
    this._tokensReady = false;
    this._tokenPromise = null;

    this.headers = {
      'User-Agent': this.userAgent,
      // 参考 DouK-Downloader：携带 recommend 参数的 Referer 更接近真实浏览器行为
      'Referer': `${DOUYIN_DOMAIN}?recommend=1`,
      'Cookie': cookie,
    };

    // 与官方 Web 端对齐的完整请求参数（版本号、清晰度支持等）
    // 缺失 support_dash/support_h265 会导致拿不到高清晰度地址，缺失 uifid/engine 等易被风控拦截
    this.baseParams = {
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      update_version_code: '170400',
      pc_client_type: '1',
      pc_libra_divert: 'Windows',
      support_h265: '1',
      support_dash: '1',
      version_code: '290100',
      version_name: '29.1.0',
      cookie_enabled: 'true',
      screen_width: '1536',
      screen_height: '864',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      browser_version: '139.0.0.0',
      browser_online: 'true',
      engine_name: 'Blink',
      engine_version: '139.0.0.0',
      os_name: 'Windows',
      os_version: '10',
      cpu_core_num: '16',
      device_memory: '8',
      platform: 'PC',
      downlink: '10',
      effective_type: '4g',
      round_trip_time: '200',
      uifid: '',
    };
  }

  generateWebId() {
    // 生成随机webid (19位数字)
    return '7' + Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('');
  }

  generateMsToken() {
    // 生成随机msToken (与官方一致的 156 位字符)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    return Array.from({ length: 156 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  // 从 Set-Cookie 响应头中提取指定 cookie 值
  extractSetCookie(setCookieHeader, key) {
    if (!setCookieHeader) return null;
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const item of list) {
      const match = item.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
      if (match) return match[1];
    }
    return null;
  }

  // 获取真实 ttwid（设备标识，风控关键参数）
  async fetchTtwid() {
    try {
      const resp = await axios.post(
        'https://ttwid.bytedance.com/ttwid/union/register/',
        '{"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com","migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}',
        {
          headers: { 'User-Agent': this.userAgent, 'Content-Type': 'text/plain;charset=UTF-8' },
          timeout: 15000,
          ...(this.proxy ? { proxy: this.proxy } : {}),
        }
      );
      return this.extractSetCookie(resp.headers['set-cookie'], 'ttwid');
    } catch (error) {
      console.warn('[DouyinAPI] 获取 ttwid 失败，使用本地伪造值:', error.message);
      return null;
    }
  }

  // 获取真实 webid
  async fetchWebId() {
    try {
      const data = `{"app_id":6383,"url":"https://www.douyin.com/","user_agent":"${this.userAgent}","referer":"https://www.douyin.com/","user_unique_id":""}`;
      const resp = await axios.post('https://mcs.zijieapi.com/webid', data, {
        params: { aid: '6383', sdk_version: '5.1.18_zip', device_platform: 'web' },
        headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/json' },
        timeout: 15000,
        ...(this.proxy ? { proxy: this.proxy } : {}),
      });
      return resp.data && resp.data.web_id ? resp.data.web_id : null;
    } catch (error) {
      console.warn('[DouyinAPI] 获取 webid 失败，使用本地伪造值:', error.message);
      return null;
    }
  }

  // 懒加载真实签名参数，只在首次请求时获取一次（并发去重）
  async ensureTokens() {
    if (this._tokensReady) return;
    if (this._tokenPromise) return this._tokenPromise;

    this._tokenPromise = (async () => {
      const [ttwid, webid] = await Promise.all([this.fetchTtwid(), this.fetchWebId()]);
      if (ttwid) {
        this.ttwid = ttwid;
        // 将 ttwid 合并进 Cookie 头（避免重复）
        if (!/(?:^|;\s*)ttwid=/.test(this.headers.Cookie || '')) {
          this.headers.Cookie = `${this.headers.Cookie ? this.headers.Cookie + '; ' : ''}ttwid=${ttwid}`;
        }
      }
      if (webid) this.webid = webid;
      // 任一成功即认为已就绪；全部失败则下次请求重试
      this._tokensReady = !!(ttwid || webid);
      this._tokenPromise = null;
    })();

    return this._tokenPromise;
  }

  async request(url, params = {}, method = 'GET', data = null) {
    // 首次请求前确保已尝试获取真实签名参数
    await this.ensureTokens();

    console.log('[DouyinAPI] Request URL:', url);

    let lastError;
    // 首次 + maxRetry 次重试
    for (let attempt = 0; attempt <= this.maxRetry; attempt++) {
      // 每次尝试都重新生成参数与签名（a_bogus 含时间戳，复用会失效）
      const fullParams = {
        ...this.baseParams,
        webid: this.webid,
        msToken: this.msToken,
        ...params,
      };
      const queryString = new URLSearchParams(fullParams).toString();
      fullParams.a_bogus = this.aBogus.getValue(queryString, method);

      const config = {
        method,
        url,
        params: fullParams,
        headers: this.headers,
        timeout: this.timeout,
      };

      if (this.proxy) {
        config.proxy = this.proxy;
      }

      if (data && method === 'POST') {
        config.data = data;
      }

      try {
        const response = await axios(config);
        console.log('[DouyinAPI] Response status:', response.status);
        return response.data;
      } catch (error) {
        lastError = error;
        console.error(
          `[DouyinAPI] 请求失败 (第 ${attempt + 1}/${this.maxRetry + 1} 次):`,
          error.message
        );
        if (error.response) {
          console.error('[DouyinAPI] Response status:', error.response.status);
        }
        // 还有重试机会则等待后重试（递增退避）
        if (attempt < this.maxRetry) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    throw new Error(`Request failed after ${this.maxRetry + 1} attempts: ${lastError.message}`);
  }

  async resolveShareLink(shortUrl) {
    try {
      const response = await axios.get(shortUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      return response.headers.location || response.request.res.responseUrl;
    } catch (error) {
      if (error.response && error.response.headers.location) {
        return error.response.headers.location;
      }
      throw error;
    }
  }

  async getVideoDetail(awemeId) {
    const url = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
    const params = {
      aweme_id: awemeId,
      // 作品详情接口需使用旧版本号（与 DouK-Downloader 一致）
      version_code: '190500',
      version_name: '19.5.0',
    };
    return await this.request(url, params);
  }

  async getUserProfile(secUserId) {
    const url = 'https://www.douyin.com/aweme/v1/web/user/profile/other/';
    const params = {
      sec_user_id: secUserId,
    };
    return await this.request(url, params);
  }

  async getUserVideos(secUserId, maxCursor = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
    const params = {
      sec_user_id: secUserId,
      max_cursor: maxCursor,
      count,
      // 策略 2：包含部分早期图集作品。默认缺省时接口会漏掉一批 aweme_type=68 的图集
      // （实测某账号默认只返回 69 条，加上该参数可拿到 72 条），不传会少下载图集。
      publish_video_strategy_type: 2,
    };
    return await this.request(url, params);
  }

  async getUserLikedVideos(secUserId, maxCursor = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/aweme/favorite/';
    const params = {
      sec_user_id: secUserId,
      max_cursor: maxCursor,
      count,
    };
    return await this.request(url, params);
  }

  async getUserCollections(secUserId, cursor = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/';
    const params = {
      sec_user_id: secUserId,
      cursor,
      count,
    };
    return await this.request(url, params);
  }

  async getVideoComments(awemeId, cursor = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/comment/list/';
    const params = {
      aweme_id: awemeId,
      cursor,
      count,
    };
    return await this.request(url, params);
  }

  // 获取楼中楼子评论（reply_comment_total > 0 的评论下的回复）
  async getCommentReplies(awemeId, commentId, cursor = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/comment/list/reply/';
    const params = {
      item_id: awemeId,
      comment_id: commentId,
      cursor,
      count,
    };
    return await this.request(url, params);
  }

  async searchVideos(keyword, offset = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/general/search/single/';
    const params = {
      keyword,
      search_channel: 'aweme_video_web',
      offset,
      count,
    };
    return await this.request(url, params);
  }

  async searchUsers(keyword, offset = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/discover/search/';
    const params = {
      keyword,
      search_channel: 'aweme_user_web',
      offset,
      count,
    };
    return await this.request(url, params);
  }

  async getLiveStream(webRid) {
    const url = 'https://live.douyin.com/webcast/room/web/enter/';
    const params = {
      web_rid: webRid,
    };
    return await this.request(url, params);
  }

  async getMixVideos(mixId, cursor = 0, count = 20) {
    const url = 'https://www.douyin.com/aweme/v1/web/mix/aweme/';
    const params = {
      mix_id: mixId,
      cursor,
      count,
    };
    return await this.request(url, params);
  }

  async getHotBoard(board_type = 1) {
    const url = 'https://www.douyin.com/aweme/v1/web/hot/search/list/';
    const params = {
      board_type,
    };
    return await this.request(url, params);
  }

  // 检查Cookie状态
  checkCookieStatus() {
    // 检查Cookie中是否有sessionid_ss字段
    const cookies = this.cookie.split(';').map(c => c.trim());
    const sessionidCookie = cookies.find(c => c.startsWith('sessionid_ss='));

    if (sessionidCookie && sessionidCookie.split('=')[1]) {
      return {
        isValid: true,
        isLoggedIn: true,
        message: 'Cookie有效，已登录'
      };
    } else if (this.cookie) {
      return {
        isValid: true,
        isLoggedIn: false,
        message: 'Cookie存在但未登录'
      };
    } else {
      return {
        isValid: false,
        isLoggedIn: false,
        message: 'Cookie为空'
      };
    }
  }
}

class TikTokAPI {
  constructor(cookie = '', proxy = null) {
    this.cookie = cookie;
    this.proxy = proxy;
    this.userAgent = USERAGENT;

    this.headers = {
      'User-Agent': this.userAgent,
      'Referer': TIKTOK_DOMAIN,
      'Cookie': cookie,
    };

    this.baseParams = {
      device_platform: 'web_pc',
      aid: '1988',
      channel: 'tiktok_web',
      region: 'US',
      priority_region: 'US',
      os: 'windows',
      device_type: 'pc',
      version_code: '290100',
      version_name: '29.1.0',
      cookie_enabled: 'true',
      screen_width: '1536',
      screen_height: '864',
      browser_language: 'en-US',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      browser_version: '120.0.0.0',
    };
  }

  async request(url, params = {}, method = 'GET', data = null) {
    // Merge params with base params
    const fullParams = { ...this.baseParams, ...params };

    // Generate XBogus signature
    const xBogusValue = XBogus.getXBogus(fullParams, 8, this.userAgent);
    fullParams['X-Bogus'] = xBogusValue;

    const config = {
      method,
      url,
      params: fullParams,
      headers: this.headers,
      timeout: 30000,
    };

    if (this.proxy) {
      config.proxy = this.proxy;
    }

    if (data && method === 'POST') {
      config.data = data;
    }

    try {
      const response = await axios(config);
      return response.data;
    } catch (error) {
      throw new Error(`Request failed: ${error.message}`);
    }
  }

  async resolveShareLink(shortUrl) {
    try {
      const response = await axios.get(shortUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      return response.headers.location || response.request.res.responseUrl;
    } catch (error) {
      if (error.response && error.response.headers.location) {
        return error.response.headers.location;
      }
      throw error;
    }
  }

  async getVideoDetail(videoId) {
    const url = 'https://www.tiktok.com/api/item/detail/';
    const params = {
      itemId: videoId,
    };
    return await this.request(url, params);
  }

  async getUserProfile(uniqueId) {
    const url = 'https://www.tiktok.com/api/user/detail/';
    const params = {
      uniqueId,
    };
    return await this.request(url, params);
  }

  async getUserVideos(secUserId, maxCursor = 0, count = 20) {
    const url = 'https://www.tiktok.com/api/post/item_list/';
    const params = {
      secUid: secUserId,
      cursor: maxCursor,
      count,
    };
    return await this.request(url, params);
  }
}

/**
 * 哔哩哔哩直播 API
 * 独立实现，不依赖抖音签名/Cookie。
 * 接口：https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo
 * 返回 playurl_info.playurl.stream[].format[].codec[].base_url + url_info 拼出 FLV/HLS 流地址。
 */
class BiliLiveAPI {
  constructor() {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  }

  // 从直播间 URL 或 room_id 获取 room_id（数字）
  // 例如 https://live.bilibili.com/9490654 -> 9490654
  parseRoomId(input) {
    const s = String(input || '').trim();
    // 纯数字
    if (/^\d+$/.test(s)) return s;
    // URL 提取
    const m = s.match(/live\.bilibili\.com\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  // 获取直播间信息（标题、主播、是否开播、流地址）
  async getRoomInfo(roomIdInput) {
    const roomId = this.parseRoomId(roomIdInput);
    if (!roomId) throw new Error('无法识别直播间 ID，请输入直播间链接或数字 ID');

    const headers = {
      'User-Agent': this.userAgent,
      'Referer': `https://live.bilibili.com/${roomId}`,
      'Accept': 'application/json, text/plain, */*',
    };

    // 1. 取房间基础信息（标题、主播、直播状态）
    // getRoomInfoOld 返回 code/data/{room_info, anchor_info}
    let title = `bilibili_${roomId}`;
    let uname = '';
    let liveStatus = 0; // 0=未开播 1=直播中 2=轮播
    let shortId = roomId;
    let resolvedRoomId = roomId;
    try {
      const infoRes = await axios.get('https://api.live.bilibili.com/room/v1/Room/get_info', {
        params: { room_id: roomId },
        headers,
        timeout: 10000,
      });
      if (infoRes.data && infoRes.data.code === 0 && infoRes.data.data) {
        const d = infoRes.data.data;
        title = d.title || title;
        liveStatus = d.live_status || 0; // 1=直播中 0=未开播 2=轮播
        shortId = d.short_id ? String(d.short_id) : roomId;
        resolvedRoomId = d.room_id ? String(d.room_id) : roomId;
      }
    } catch (e) {
      console.warn('[BiliLive] get_info 失败:', e.message);
    }

    // get_info 不稳定地省略主播名；getInfoByRoom 的 anchor_info 才是权威来源。
    try {
      const ownerRes = await axios.get('https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom', {
        params: { room_id: resolvedRoomId },
        headers,
        timeout: 10000,
      });
      const owner = ownerRes.data && ownerRes.data.code === 0 ? ownerRes.data.data : null;
      if (owner) {
        uname = owner.anchor_info?.base_info?.uname || owner.uname || uname;
        title = owner.room_info?.title || title;
        liveStatus = owner.room_info?.live_status ?? liveStatus;
        shortId = owner.room_info?.short_id ? String(owner.room_info.short_id) : shortId;
        resolvedRoomId = owner.room_info?.room_id ? String(owner.room_info.room_id) : resolvedRoomId;
      }
    } catch (e) {
      console.warn('[BiliLive] getInfoByRoom 失败:', e.message);
    }

    // 2. 取直播流地址 getRoomPlayInfo（v2）
    // 需要 room_id（真实 ID）。get_info 返回的 room_id 才是真实 ID，但短 ID 也能用
    let streamUrl = null;
    let streamType = '';
    if (liveStatus === 1) {
      try {
        const playRes = await axios.get('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo', {
          params: {
            room_id: resolvedRoomId,
            protocol: 0,     // 0=FLV 1=HLS
            format: 0,       // 0=FLV/TS 1=HLS 2=RAW
            codec: 0,        // 0=AVC 1=HEVC
            qn: 10000,       // 10000=原画
            platform: 'web',
            p2p_type: -1,
          },
          headers,
          timeout: 10000,
        });
        if (playRes.data && playRes.data.code === 0 && playRes.data.data) {
          const playurl = playRes.data.data.playurl_info?.playurl;
          if (playurl && Array.isArray(playurl.stream)) {
            for (const stream of playurl.stream) {
              if (Array.isArray(stream.format)) {
                for (const fmt of stream.format) {
                  if (Array.isArray(fmt.codec) && fmt.codec.length > 0) {
                    const codec = fmt.codec[0];
                    if (codec.base_url) {
                      // 拼接 url_info 的 host + base_url + 后缀
                      const urlInfo = (codec.url_info && codec.url_info[0]) || {};
                      streamUrl = (urlInfo.host || '') + codec.base_url + (urlInfo.extra || '');
                      streamType = (fmt.format_name || '').toUpperCase() || 'FLV';
                      break;
                    }
                  }
                }
              }
              if (streamUrl) break;
            }
          }
        }
      } catch (e) {
        console.warn('[BiliLive] getRoomPlayInfo 失败:', e.message);
      }
    }

    return {
      room_id: resolvedRoomId,
      short_id: shortId,
      title,
      uname,
      live_status: liveStatus, // 0=未开播 1=直播中 2=轮播
      stream_url: streamUrl,
      stream_type: streamType,
      platform: 'bilibili',
    };
  }
}

module.exports = { DouyinAPI, TikTokAPI, BiliLiveAPI };
