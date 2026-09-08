/**
 * HTTP 请求工具类 - Electron 主进程版（基于 axios，替代原 uni-app 的 uni.request）
 *
 * 默认 maxRedirects:5 自动跟随重定向（与原 uni.request 一致）；
 * 需要手动读取 Location 头的场景（如 getFinalUrl）通过 options.maxRedirects:0 覆盖。
 */
const axios = require('axios');

class HttpClient {
  constructor() {
    this.timeout = 30000;
  }

  /**
   * 发送 HTTP 请求
   * 接口与原 uni.request 一致：{ url, method, data, header, timeout }
   * 返回与原 uni.request 一致：{ statusCode, data, header }
   */
  async request(options) {
    const method = (options.method || 'GET').toUpperCase();
    let url = options.url;
    const header = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
      'Accept': '*/*',
      ...(options.header || {})
    };
    const timeout = options.timeout || this.timeout;

    // GET 请求把 data 拼到 URL 上（和原 buildQueryString 行为一致）
    let data = options.data || {};
    if (method === 'GET' && data && Object.keys(data).length > 0) {
      const qs = this.buildQueryString(data);
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
      data = undefined;
    }

    try {
      const response = await axios({
        url,
        method,
        data: method !== 'GET' ? data : undefined,
        headers: header,
        timeout,
        // 默认跟随重定向（与原 uni.request 行为一致）；
        // 调用方可通过 options.maxRedirects 覆盖（如 getFinalUrl 需 0 来读 Location 头）
        maxRedirects: options.maxRedirects !== undefined ? options.maxRedirects : 5,
        validateStatus: () => true, // 接受所有状态码（3xx 也要返回）
        responseType: 'arraybuffer', // 用 arraybuffer 再自己解析，避免 JSON/编码问题
        // 不设 transformResponse，自己处理
      });

      // 解析响应体
      let body = response.data;
      const contentType = (response.headers['content-type'] || response.headers['Content-Type'] || '').toLowerCase();

      // arraybuffer -> 字符串/对象
      if (Buffer.isBuffer(body)) {
        const text = body.toString('utf8');
        if (contentType.includes('application/json')) {
          try { body = JSON.parse(text); } catch { body = text; }
        } else {
          // 尝试 JSON 解析（很多 API 返回 JSON 但没设 content-type）
          try { body = JSON.parse(text); } catch { body = text; }
        }
      }

      return {
        statusCode: response.status,
        data: body,
        header: response.headers
      };
    } catch (err) {
      throw err;
    }
  }

  async get(url, data = {}, options = {}) {
    return this.request({ url, method: 'GET', data, ...options });
  }

  async post(url, data = {}, options = {}) {
    return this.request({ url, method: 'POST', data, ...options });
  }

  buildQueryString(obj) {
    const params = [];
    for (let key in obj) {
      if (obj[key] !== undefined && obj[key] !== null) {
        params.push(`${encodeURIComponent(key)}=${encodeURIComponent(obj[key])}`);
      }
    }
    return params.join('&');
  }

  async getFinalUrl(url) {
    try {
      // maxRedirects:0 才能拿到 3xx 响应与 Location 头；
      // 若用默认的 5，axios 会自动跟随到 200，本方法永远只能返回原始 url
      const res = await this.get(url, {}, {
        header: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15' },
        maxRedirects: 0,
      });
      if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
        return res.header.Location || res.header.location || url;
      }
      return url;
    } catch (err) {
      return url;
    }
  }

  /**
   * 发送请求并跟随重定向直到拿到最终响应（对 maxRedirects:0 的补充）
   * 大部分解析器用 request() 拿到 3xx 自己处理 Location；
   * 少数解析器（小红书、西瓜等）需要最终的 200 页面，用这个方法。
   */
  async requestFollowRedirects(options, maxRedirects = 8) {
    let opts = { ...options };
    let redirectCount = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.request(opts);
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.header['location'] || res.header.Location;
        if (location && redirectCount < maxRedirects) {
          redirectCount++;
          // 处理相对路径
          let nextUrl = location;
          if (nextUrl.startsWith('/')) {
            const u = new (require('url').URL)(opts.url);
            nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
          }
          opts.url = nextUrl;
          continue;
        }
      }
      return res;
    }
  }
}

/**
 * URL 提取工具
 */
class UrlExtractor {
  static extractUrl(text) {
    if (!text) return null;
    const urlPattern = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlPattern);
    if (matches && matches.length > 0) {
      let url = matches[0];
      url = url.replace(/[。，！？、；："""''）」』】>《\]\[(<]+$/, '');
      url = url.replace(/[，,。.；;]+$/, '');
      return url;
    }
    return null;
  }

  static detectPlatform(url) {
    if (!url) return null;
    const platformPatterns = {
      'douyin': ['douyin.com', 'iesdouyin.com', 'v.douyin.com'],
      'kuaishou': ['kuaishou.com', 'v.kuaishou.com', 'kuaishouapp.com', 'chenzhongtech.com', 'gifshow.com'],
      'xiaohongshu': ['xiaohongshu.com', 'xhslink.com'],
      'pipixia': ['pipix.com', 'pipixia.com', 'h5.pipix.com'],
      'bilibili': ['bilibili.com', 'b23.tv', 'b23.wtf', 'acg.tv'],
      'xigua': ['ixigua.com', 'm.ixigua.com'],
      'weishi': ['weishi.qq.com', 'isee.weishi.qq.com'],
      'zuiyou': ['zuiyou.com', 'xiaochuankeji.cn', 'izuiyou.com'],
      'huoshan': ['huoshan.com', 'share.huoshan.com'],
      'quanmin': ['quanmin.baidu.com'],
      'haokan': ['haokan.baidu.com', 'mbd.baidu.com'],
      'lishipin': ['pearvideo.com'],
      'huya': ['huya.com'],
      'acfun': ['acfun.cn'],
      'meipai': ['meipai.com'],
      'quanminkge': ['kg.qq.com'],
      'sixroom': ['6.cn', '6room.com'],
      'weibo': ['weibo.com', 'weibo.cn', 'm.weibo.cn', 'video.weibo.com'],
      'youtube': ['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'],
      'tiktok': ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com']
    };

    const lowerUrl = url.toLowerCase();
    for (let platform in platformPatterns) {
      const domains = platformPatterns[platform];
      for (let domain of domains) {
        if (lowerUrl.includes(domain)) {
          return platform;
        }
      }
    }
    if (lowerUrl.includes('t.cn/')) {
      return 'weibo';
    }
    return null;
  }
}

module.exports = HttpClient;
module.exports.UrlExtractor = UrlExtractor;
module.exports.default = HttpClient;
