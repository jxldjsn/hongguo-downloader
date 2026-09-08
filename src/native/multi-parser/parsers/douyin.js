/**
 * 抖音解析器
 */
const HttpClient = require('../http')

class DouyinParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析抖音视频
   */
  async parse(url) {
    try {
      console.log('开始解析抖音URL:', url)

      // 1. 获取真实URL（处理短链接）
      let finalUrl = url.trim()

      if (finalUrl.includes('v.douyin.com') || finalUrl.includes('iesdouyin.com/share')) {
        console.log('检测到短链接，正在获取真实URL...')
        finalUrl = await this.getFinalUrl(finalUrl)
        console.log('获取到真实URL:', finalUrl)
      }

      // 2. 提取视频ID
      const videoId = this.extractVideoId(finalUrl)
      if (!videoId) {
        // 如果从finalUrl提取失败，尝试从原始URL提取
        console.log('从真实URL提取失败，尝试从原始URL提取...')
        const videoIdFromOriginal = this.extractVideoId(url)
        if (!videoIdFromOriginal) {
          throw new Error('无法提取视频ID，请检查链接是否正确')
        }
        return await this.getVideoInfo(videoIdFromOriginal)
      }

      // 3. 获取视频信息
      const videoInfo = await this.getVideoInfo(videoId)

      return videoInfo
    } catch (error) {
      console.error('抖音解析失败:', error)
      throw error
    }
  }

  /**
   * 获取重定向后的URL（支持多次重定向）
   */
  async getFinalUrl(shortUrl, depth = 0) {
    // 防止无限递归
    if (depth > 5) {
      console.log('重定向次数超过5次，停止递归')
      return shortUrl
    }

    try {
      console.log(`[重定向第${depth + 1}次] 请求URL:`, shortUrl)

      const res = await this.http.request({
        url: shortUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.20'
        },
        timeout: 10000
      })

      console.log('短链接响应 - 状态码:', res.statusCode)

      let extractedUrl = null

      // 从响应体中提取URL
      if (res.data && typeof res.data === 'string') {
        console.log('响应体前500字符:', res.data.substring(0, 500))

        // 方法1: 匹配 location.replace("xxx")
        let match = res.data.match(/location\.replace\(["']([^"']+)["']\)/)
        if (match) {
          extractedUrl = decodeURIComponent(match[1])
          console.log('通过location.replace提取到URL:', extractedUrl)
        }

        // 方法2: 匹配 window.location.href = "xxx"
        if (!extractedUrl) {
          match = res.data.match(/window\.location\.href\s*=\s*["']([^"']+)["']/)
          if (match) {
            extractedUrl = decodeURIComponent(match[1])
            console.log('通过window.location.href提取到URL:', extractedUrl)
          }
        }

        // 方法3: 匹配页面中的视频链接
        if (!extractedUrl) {
          match = res.data.match(/https?:\/\/www\.douyin\.com\/video\/(\d+)/)
          if (match) {
            extractedUrl = match[0]
            console.log('通过video路径提取到URL:', extractedUrl)
          }
        }

        // 方法4: 匹配 note 路径（图集）
        if (!extractedUrl) {
          match = res.data.match(/https?:\/\/www\.douyin\.com\/note\/(\d+)/)
          if (match) {
            extractedUrl = match[0]
            console.log('通过note路径提取到URL:', extractedUrl)
          }
        }

        // 方法5: 匹配 discover 路径
        if (!extractedUrl) {
          match = res.data.match(/https?:\/\/www\.douyin\.com\/discover[^"'\s]*/)
          if (match) {
            extractedUrl = match[0]
            console.log('通过discover路径提取到URL:', extractedUrl)
          }
        }

        // 方法6: 匹配任何 douyin.com 链接
        if (!extractedUrl) {
          match = res.data.match(/https?:\/\/[^"'\s]*douyin\.com\/[^"'\s]+/)
          if (match) {
            extractedUrl = match[0]
            console.log('通过通用匹配提取到URL:', extractedUrl)
          }
        }
      }

      // 从响应头中获取重定向URL（支持大小写）
      if (!extractedUrl && res.header) {
        const location = res.header.location || res.header.Location || res.header['location']
        if (location) {
          extractedUrl = location
          console.log('从响应头获取到重定向URL:', extractedUrl)
        }
      }

      // 如果提取到了URL，检查是否还是短链接
      if (extractedUrl) {
        // 检查是否仍然是短链接（v.douyin.com, z.douyin.com等）
        const isStillShortLink = extractedUrl.includes('v.douyin.com') ||
                                 extractedUrl.includes('z.douyin.com') ||
                                 (extractedUrl.includes('douyin.com') && !extractedUrl.match(/\/(video|note)\/\d+/))

        if (isStillShortLink) {
          console.log('提取到的URL仍然是短链接，继续重定向...')
          return await this.getFinalUrl(extractedUrl, depth + 1)
        }

        console.log('✅ 获取到最终URL:', extractedUrl)
        return extractedUrl
      }

      console.log('所有方法都未能提取到真实URL，返回原始URL')
      return shortUrl
    } catch (err) {
      console.error('获取真实URL失败:', err)
      return shortUrl
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    console.log('正在提取视频ID，URL:', url)

    // 匹配各种抖音URL格式
    const patterns = [
      /\/video\/(\d+)/,                    // https://www.douyin.com/video/123456789
      /\/note\/(\d+)/,                     // https://www.douyin.com/note/123456789 (图集)
      /modal_id=(\d+)/,                    // ?modal_id=123456789
      /\/share\/video\/(\d+)/,             // /share/video/123456789
      /\/share\/note\/(\d+)/,              // /share/note/123456789 (图集分享)
      /aweme\/v\d+\/(\d+)/,                // aweme/v1/123456789
      /item_ids=(\d+)/,                    // item_ids=123456789
      /video_id=(\d+)/,                    // video_id=123456789
      /note_id=(\d+)/,                     // note_id=123456789 (图集)
      /\/discover\?modal_id=(\d+)/,        // /discover?modal_id=123456789
    ]

    for (const pattern of patterns) {
      const match = url.match(pattern)
      if (match && match[1]) {
        console.log('成功提取视频ID:', match[1], '匹配模式:', pattern.source)
        return match[1]
      }
    }

    // 尝试从整个URL中提取19位数字（抖音视频ID固定19位）
    const allNumbers = url.match(/\d{19}/g)
    if (allNumbers && allNumbers.length > 0) {
      console.log('通过19位数字匹配到ID:', allNumbers[0])
      return allNumbers[0]
    }

    // 尝试提取18位数字（某些情况下ID可能是18位）
    const eighteenDigits = url.match(/\d{18}/g)
    if (eighteenDigits && eighteenDigits.length > 0) {
      console.log('通过18位数字匹配到ID:', eighteenDigits[0])
      return eighteenDigits[0]
    }

    console.error('无法从URL中提取视频ID:', url)
    return null
  }

  /**
   * 获取视频详细信息（参考PHP版本，从HTML中提取数据）
   */
  async getVideoInfo(videoId) {
    try {
      console.log('正在获取视频信息，ID:', videoId)

      // 尝试多个URL格式（视频和图集）
      const pageUrls = [
        `https://www.iesdouyin.com/share/video/${videoId}`,  // 视频格式
        `https://www.iesdouyin.com/share/note/${videoId}`,   // 图集格式
      ]

      let html = null
      let successUrl = null

      // 尝试不同的URL
      for (const pageUrl of pageUrls) {
        try {
          console.log('尝试请求URL:', pageUrl)

          const res = await this.http.request({
            url: pageUrl,
            method: 'GET',
            header: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            timeout: 10000
          })

          console.log('请求完成，状态码:', res.statusCode)

          if (res.statusCode === 200 && res.data && res.data !== '') {
            html = res.data
            successUrl = pageUrl
            console.log('成功获取网页数据，URL:', pageUrl)
            break
          }
        } catch (err) {
          console.log('URL请求失败:', pageUrl, err.message)
          continue
        }
      }

      if (!html) {
        console.log('所有URL都请求失败，尝试使用图集API')
        // 直接尝试图集API
        const data = await this.fetchSlideInfo(videoId)
        if (data) {
          return this.parseVideoData(data, videoId)
        }
        throw new Error('无法获取视频数据，所有方法都失败了')
      }

      console.log('响应数据长度:', html.length)

      // 方法1: 提取 window._ROUTER_DATA（优先）
      let data = this.extractRouterData(html)

      if (!data) {
        // 方法2: 提取 window._INITIAL_STATE_（备用）
        console.log('尝试提取 _INITIAL_STATE_')
        data = this.extractInitialState(html)
      }

      if (!data) {
        // 方法3: 尝试使用图集API
        console.log('HTML提取失败，尝试使用图集API')
        data = await this.fetchSlideInfo(videoId)
      }

      if (!data) {
        throw new Error('无法从网页中提取视频数据')
      }

      // 解析并返回视频信息
      return this.parseVideoData(data, videoId)

    } catch (error) {
      console.error('获取抖音视频信息失败:', error)
      throw new Error('解析失败: ' + (error.message || '请稍后重试'))
    }
  }

  /**
   * 从HTML中提取 window._ROUTER_DATA
   */
  extractRouterData(html) {
    try {
      console.log('尝试提取 _ROUTER_DATA')

      // 匹配: window._ROUTER_DATA = {...}</script>
      const pattern = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s
      const match = html.match(pattern)

      if (!match || !match[1]) {
        console.log('未找到 _ROUTER_DATA')
        return null
      }

      console.log('找到 _ROUTER_DATA，长度:', match[1].length)

      const jsonStr = match[1].trim()
      const jsonData = JSON.parse(jsonStr)

      // 提取视频数据
      const videoData = jsonData?.loaderData?.['video_(id)/page']?.videoInfoRes?.item_list?.[0]

      if (videoData) {
        console.log('成功从 _ROUTER_DATA 提取视频数据')
        return videoData
      }

      console.log('_ROUTER_DATA 中未找到视频数据')
      return null
    } catch (error) {
      console.error('提取 _ROUTER_DATA 失败:', error)
      return null
    }
  }

  /**
   * 从HTML中提取 window._INITIAL_STATE_
   */
  extractInitialState(html) {
    try {
      console.log('尝试提取 _INITIAL_STATE_')

      // 匹配: window._INITIAL_STATE_ = {...}
      const pattern = /window\._INITIAL_STATE_\s*=\s*({.*?});/s
      const match = html.match(pattern)

      if (!match || !match[1]) {
        console.log('未找到 _INITIAL_STATE_')
        return null
      }

      console.log('找到 _INITIAL_STATE_')

      const jsonData = JSON.parse(match[1])

      // 可能的数据路径
      const videoData = jsonData?.itemInfo?.itemStruct ||
                       jsonData?.detail?.itemInfo?.itemStruct ||
                       null

      if (videoData) {
        console.log('成功从 _INITIAL_STATE_ 提取视频数据')
        return videoData
      }

      console.log('_INITIAL_STATE_ 中未找到视频数据')
      return null
    } catch (error) {
      console.error('提取 _INITIAL_STATE_ 失败:', error)
      return null
    }
  }

  /**
   * 使用图集API获取数据（备用方法）
   */
  async fetchSlideInfo(videoId) {
    try {
      console.log('使用图集API获取数据')

      // 生成随机参数
      const webId = '75' + this.randomNumeric(15)
      const aBogus = this.randomString(64)

      const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/?reflow_source=reflow_page&web_id=${webId}&device_id=${webId}&aweme_ids=%5B${videoId}%5D&request_source=200&a_bogus=${aBogus}`

      const res = await this.http.request({
        url: apiUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Referer': 'https://www.douyin.com/'
        }
      })

      if (res.statusCode !== 200) {
        console.log('图集API请求失败，状态码:', res.statusCode)
        return null
      }

      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
      const videoData = data?.aweme_details?.[0]

      if (videoData) {
        console.log('成功从图集API获取数据')
        return videoData
      }

      return null
    } catch (error) {
      console.error('图集API调用失败:', error)
      return null
    }
  }

  /**
   * 生成随机数字字符串
   */
  randomNumeric(length) {
    let result = ''
    for (let i = 0; i < length; i++) {
      result += Math.floor(Math.random() * 10)
    }
    return result
  }

  /**
   * 生成随机字符串
   */
  randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  /**
   * 解析视频数据（提取成单独方法，支持不同API结构）
   */
  parseVideoData(item, videoId) {
    // 解析视频信息
    const result = {
      platform: 'douyin',
      platformName: '抖音',
      title: item.desc || '无标题',
      cover: item.video?.cover?.url_list?.[0] || item.video?.origin_cover?.url_list?.[0] || '',
      author: {
        uid: item.author?.uid || item.author?.sec_uid || '',
        name: item.author?.nickname || '未知',
        avatar: item.author?.avatar_thumb?.url_list?.[0] || item.author?.avatar_larger?.url_list?.[0] || ''
      },
      music: {
        title: item.music?.title || '',
        url: item.music?.play_url?.url_list?.[0] || '',
        author: item.music?.author || ''
      },
      statistics: {
        digg: item.statistics?.digg_count || 0,
        comment: item.statistics?.comment_count || 0,
        share: item.statistics?.share_count || 0
      },
      createTime: item.create_time || 0,
      videoId: videoId
    }

    // 判断是视频还是图集
    // 关键：图集作品必然带非空的 images 数组（aweme_type=2/68），普通视频不带 images。
    // 不能再用 hasRealVideoStream 做兜底——图集作品的 video.play_addr.uri 可能是封面/引导视频
    // 地址（非 ies-music、不含 .mp3、duration=0、无 bit_rate），会被误判成"真视频"，导致图片丢失。
    if (item.images && item.images.length > 0) {
      // 图集（图文作品）：images 有图片，且没有真正的视频流
      // 注意：图文作品的 video.play_addr 实为 BGM 音乐地址，不能当视频下载
      result.type = 'image'
      result.images = item.images.map(img => ({
        url: this.getNoWebpUrl(img.url_list || []),
        width: img.width || 0,
        height: img.height || 0,
        // LivePhoto（图集中的动态照片）
        livePhotoUrl: img.video?.play_addr?.url_list?.[0] || ''
      }))
      // 图文作品的 BGM：video.play_addr.uri 指向 ies-music 直链（music.play_url 可能为空）
      if (!result.music.url) {
        const bgmUri = item.video?.play_addr?.uri
        if (bgmUri && typeof bgmUri === 'string' && bgmUri.includes('ies-music')) {
          result.music.url = bgmUri
        }
      }
      console.log('解析成功：图集，共', result.images.length, '张，BGM:', result.music.url ? '有' : '无')
    } else {
      // 视频
      result.type = 'video'

      // 获取视频URL（优先使用play_addr）
      let videoUrl = item.video?.play_addr?.url_list?.[0] ||
                    item.video?.download_addr?.url_list?.[0] || ''

      // 关键：去除水印（参考PHP版本）
      // playwm -> play (带水印 -> 无水印)
      const noWatermarkUrl = videoUrl.replace(/playwm/g, 'play')

      result.video = {
        url: videoUrl,
        urlNoWatermark: noWatermarkUrl,
        width: item.video?.width || 0,
        height: item.video?.height || 0,
        duration: item.video?.duration || 0,
        ratio: item.video?.ratio || ''
      }
      console.log('解析成功：视频')
      console.log('原始URL包含水印:', videoUrl.includes('playwm'))
      console.log('已生成无水印URL')
    }

    return result
  }

  /**
   * 优先获取非webp格式的URL（参考PHP版本）
   */
  getNoWebpUrl(urlList) {
    if (!urlList || urlList.length === 0) {
      return ''
    }

    // 查找非webp格式的URL
    for (const url of urlList) {
      if (!url.includes('.webp')) {
        return url
      }
    }

    // 如果都是webp，返回第一个
    return urlList[0] || ''
  }

  /**
   * 判断 item 是否有真正的视频流（而非图文作品的 BGM）
   * 图文作品(aweme_type=2)的 video.play_addr 指向 ies-music 的 mp3，不是视频
   */
  hasRealVideoStream(item) {
    const v = item && item.video
    if (!v) return false
    // 1. 真视频会有码率档位
    if (Array.isArray(v.bit_rate) && v.bit_rate.length > 0) return true
    // 2. 真视频有时长
    if (v.duration && Number(v.duration) > 0) return true
    // 3. play_addr.uri 指向 ies-music（图文 BGM）
    const uri = v.play_addr && v.play_addr.uri
    if (uri && typeof uri === 'string' && uri.includes('ies-music')) return false
    // 4. download_addr 存在则视为真视频
    if (v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0]) return true
    // 5. play_addr.url_list 存在且不含 .mp3 才视为真视频
    const playUrl = v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0]
    if (playUrl && !playUrl.includes('.mp3')) return true
    return false
  }
}

module.exports = DouyinParser
