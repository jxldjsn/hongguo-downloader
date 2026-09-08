/**
 * 微博解析器
 */
const HttpClient = require('../http')

class WeiboParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析微博
   */
  async parse(url) {
    try {
      // 0. 处理短链接（t.cn / weibo 短链会重定向到真实地址）
      let realUrl = url
      if (/t\.cn\//i.test(url) || /\/sinaurl\?/i.test(url)) {
        realUrl = await this.getFinalUrl(url)
      }

      // 1. 提取微博ID
      const weiboId = this.extractWeiboId(realUrl)
      if (!weiboId) {
        throw new Error('无法提取微博ID')
      }

      // 2. 获取微博详情
      const weiboInfo = await this.getWeiboInfo(weiboId)

      return weiboInfo
    } catch (error) {
      console.error('微博解析失败:', error)
      throw error
    }
  }

  /**
   * 跟随短链接重定向，获取真实URL
   */
  async getFinalUrl(shortUrl) {
    try {
      const res = await this.http.request({
        url: shortUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
        }
      })

      // 优先取响应头里的重定向地址
      const location = res.header?.Location || res.header?.location
      if (location) {
        return location
      }

      // 退而从HTML里提取真实地址
      if (res.data && typeof res.data === 'string') {
        const patterns = [
          /location\.replace\(["']([^"']+)["']\)/,
          /window\.location\.href\s*=\s*["']([^"']+)["']/,
          /<meta[^>]*url=([^"'\s>]+)/i,
          /(https?:\/\/[^"'\s]*weibo\.(?:com|cn)\/[^"'\s]+)/i
        ]
        for (const p of patterns) {
          const m = res.data.match(p)
          if (m && m[1]) {
            return decodeURIComponent(m[1])
          }
        }
      }
      return shortUrl
    } catch (err) {
      console.error('微博短链重定向失败:', err)
      return shortUrl
    }
  }

  /**
   * 从URL中提取微博ID
   */
  extractWeiboId(url) {
    if (!url) return null

    // m.weibo.cn/detail/{id} 或 /status/{id}
    let match = url.match(/\/(?:detail|status)\/(\w+)/)
    if (match) {
      return match[1]
    }

    // video.weibo.com/show?fid={fid}
    match = url.match(/[?&]fid=([\w:]+)/)
    if (match) {
      return match[1]
    }

    // weibo.com/n/昵称?layerid={id}  （个人主页视频层）
    match = url.match(/[?&]layerid=(\d+)/)
    if (match) {
      return match[1]
    }

    // weibo.com/{uid}/{mid}
    match = url.match(/weibo\.(?:com|cn)\/\d+\/([A-Za-z0-9]+)/)
    if (match) {
      return match[1]
    }

    // ?id={id} / ?mid={id}
    match = url.match(/[?&](?:id|mid)=([A-Za-z0-9]+)/)
    if (match) {
      return match[1]
    }

    return null
  }

  /**
   * 获取微博详细信息
   * 优先使用 JSON API（无需访客cookie），失败再回退到 HTML detail 页面
   */
  async getWeiboInfo(weiboId) {
    // 方式1：JSON API（m.weibo.cn/statuses/show?id=）——无需访客cookie，最稳定
    try {
      const apiUrl = `https://m.weibo.cn/statuses/show?id=${weiboId}`

      const res = await this.http.get(apiUrl, {}, {
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
          'Referer': 'https://m.weibo.cn/',
          'MWeibo-Pwa': '1',
          'X-Requested-With': 'XMLHttpRequest',
        }
      })

      if (res.statusCode === 200) {
        let data = res.data
        if (typeof data === 'string') {
          data = JSON.parse(data)
        }

        // statuses/show 直接返回 { ok:1, data:{ status... } }
        if (data && data.ok === 1 && data.data) {
          const status = data.data
          return this.buildResult(status, weiboId)
        }
      }
    } catch (err) {
      console.warn('微博 JSON API 失败，回退到 detail 页面:', err.message)
    }

    // 方式2：HTML detail 页面（需要访客cookie，可能被拦截）
    const detailUrl = `https://m.weibo.cn/detail/${weiboId}`

    const res = await this.http.get(detailUrl, {}, {
      header: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://m.weibo.cn/'
      }
    })

    if (res.statusCode !== 200) {
      throw new Error('请求失败')
    }

    // 从HTML中提取JSON数据
    let data = res.data
    if (typeof data === 'string') {
      const match = data.match(/var \$render_data = \[({.+})\]\[0\]/)
      if (match) {
        data = JSON.parse(match[1])
      } else {
        throw new Error('解析失败')
      }
    }

    if (!data.status) {
      throw new Error('微博不存在或已被删除')
    }

    return this.buildResult(data.status, weiboId)
  }

  /**
   * 从微博 status 对象构建解析结果
   */
  buildResult(status, weiboId) {
    const result = {
      title: status.text?.replace(/<[^>]+>/g, '') || '无标题',
      cover: '',
      author: {
        uid: status.user?.id || '',
        name: status.user?.screen_name || '',
        avatar: status.user?.profile_image_url || ''
      },
      statistics: {
        reposts: status.reposts_count || 0,
        comments: status.comments_count || 0,
        attitudes: status.attitudes_count || 0
      },
      createTime: status.created_at || '',
      weiboId: weiboId
    }

    // 判断是视频还是图片
    if (status.page_info?.type === 'video') {
      result.type = 'video'
      // 微博视频URL键名带分辨率标识，如 mp4_1080p_mp4, mp4_720p_mp4, mp4_hd_mp4 等
      // 扫描所有键，选出最高分辨率
      const videoUrl = this.getBestWeiboVideoUrl(status.page_info)
      result.video = {
        url: videoUrl,
        cover: status.page_info.page_pic?.url || '',
        width: 0,
        height: 0,
        duration: status.page_info.duration || 0
      }
      result.cover = result.video.cover
    } else if (status.pics && status.pics.length > 0) {
      result.type = 'image'
      result.images = status.pics.map(pic => ({
        url: pic.large?.url || pic.url || '',
        width: pic.large?.geo?.width || 0,
        height: pic.large?.geo?.height || 0
      }))
      result.cover = result.images[0]?.url || ''
    } else {
      result.type = 'text'
    }

    return result
  }

  /**
   * 从微博视频URL列表中选出最高分辨率
   * 微博URL键名格式：mp4_<分辨率>_mp4，如 mp4_1080p_mp4, mp4_720p_mp4, mp4_hd_mp4, mp4_ld_mp4
   * media_info 下可能有 mp4_hd_url, mp4_ld_url 等
   */
  getBestWeiboVideoUrl(pageInfo) {
    const urls = pageInfo.urls || {}
    const mediaInfo = pageInfo.media_info || {}

    // 分辨率优先级映射（数值越大优先级越高）
    const priorityMap = {
      'mp4_4k_mp4': 40,
      'mp4_1080p_mp4': 30,
      'mp4_hd_mp4': 20,        // HD（通常 720p）
      'mp4_720p_mp4': 20,
      'mp4_ld_mp4': 10,        // LD（低清）
      'mp4_hd_url': 20,
      'mp4_ld_url': 10
    }

    // 收集所有可用URL及其优先级
    const candidates = []

    // 扫描 urls 对象的所有键
    for (const key of Object.keys(urls)) {
      const value = urls[key]
      if (value && typeof value === 'string' && value.startsWith('http')) {
        // 匹配已知键名获取优先级，未知键名尝试从键名解析分辨率
        let priority = priorityMap[key]
        if (priority === undefined) {
          // 尝试从键名提取分辨率数字
          const resMatch = key.match(/(\d{3,4})/)
          if (resMatch) {
            priority = parseInt(resMatch[1])
          } else if (key.includes('hd')) {
            priority = 20
          } else if (key.includes('ld')) {
            priority = 10
          } else {
            priority = 5
          }
        }
        candidates.push({ key, url: value, priority })
      }
    }

    // 扫描 media_info 的键
    for (const key of Object.keys(mediaInfo)) {
      const value = mediaInfo[key]
      if (value && typeof value === 'string' && value.startsWith('http') && key.includes('mp4')) {
        let priority = priorityMap[key]
        if (priority === undefined) {
          const resMatch = key.match(/(\d{3,4})/)
          if (resMatch) {
            priority = parseInt(resMatch[1])
          } else {
            priority = 5
          }
        }
        candidates.push({ key, url: value, priority })
      }
    }

    if (candidates.length === 0) return ''

    // 按优先级降序，取最高的
    candidates.sort((a, b) => b.priority - a.priority)
    console.log('微博视频流候选:', candidates.map(c => `${c.key}(${c.priority})`).join(', '))
    return candidates[0].url
  }
}

module.exports = WeiboParser
