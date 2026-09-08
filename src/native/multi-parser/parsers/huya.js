/**
 * 虎牙视频解析器
 */
const HttpClient = require('../http')

class HuyaParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析虎牙视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析虎牙URL:', url)

      // 从URL中提取视频ID（短 vid 或长 momId）
      const idInfo = this.extractVideoId(url)
      if (!idInfo) {
        throw new Error('无法提取视频ID')
      }

      // 不同 ID 类型对应不同的 API 参数名：
      //   vid（短） -> ?videoId=
      //   momId（长，来自 ?lMomId=） -> ?momId=
      const param = idInfo.type === 'momId' ? 'momId' : 'videoId'
      console.log(`ID类型: ${idInfo.type}, 值: ${idInfo.id}, API参数: ${param}`)

      const apiUrl = `https://liveapi.huya.com/moment/getMomentContent?${param}=${idInfo.id}`

      const res = await this.http.request({
        url: apiUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.102 Safari/537.36',
          'Referer': 'https://v.huya.com/'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('API请求失败，状态码:' + res.statusCode)
      }

      const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

      const videoData = jsonData?.data?.moment?.videoInfo
      if (!videoData || !videoData.definitions || videoData.definitions.length === 0) {
        throw new Error('无法获取视频信息')
      }

      // 多清晰度：按文件大小（size）降序，选最高清晰度
      const defs = videoData.definitions
        .slice()
        .sort((a, b) => (parseInt(b.size) || 0) - (parseInt(a.size) || 0))
      const bestDef = defs[0]

      // 清晰度标签
      const defLabel = this.formatDefinition(bestDef)

      // 解析视频信息
      const result = {
        platform: 'huya',
        platformName: '虎牙',
        type: 'video',
        title: videoData.videoTitle || '无标题',
        cover: videoData.videoCover || '',
        author: {
          uid: videoData.uid || '',
          name: videoData.actorNick || videoData.nickName || '未知',
          avatar: videoData.actorAvatarUrl || videoData.avatarUrl || ''
        },
        video: {
          url: bestDef.url || videoData.definitions?.[0]?.url || '',
          urlNoWatermark: bestDef.url || videoData.definitions?.[0]?.url || '',
          quality: defLabel
        }
      }

      console.log('解析成功：视频', defLabel ? `(${defLabel})` : '')
      return result

    } catch (error) {
      console.error('虎牙解析失败:', error)
      throw error
    }
  }

  /**
   * 清晰度数值转标签
   * definition 字段：4000=原画/1080p，1300=高清/720p，350=流畅/360p
   */
  formatDefinition(def) {
    if (!def) return ''
    const v = parseInt(def.definition)
    if (v >= 4000) return `原画 ${def.width}x${def.height}`
    if (v >= 1300) return `高清 ${def.width}x${def.height}`
    if (v >= 350) return `流畅 ${def.width}x${def.height}`
    return def.width ? `${def.width}x${def.height}` : ''
  }

  /**
   * 从URL中提取视频ID
   * 支持两种格式：
   *   1. https://v.huya.com/play/1234567890.html   -> vid（短数字，用 videoId= 参数）
   *   2. https://www.huya.com/video/discover/index.html?lMomId=7665313591763226240 -> momId（长数字，用 momId= 参数）
   * 返回 { type: 'vid' | 'momId', id }
   */
  extractVideoId(url) {
    // 1. 优先匹配 ?lMomId= 长数字（moment ID）
    const momMatch = url.match(/[?&]lMomId=(\d+)/)
    if (momMatch) {
      return { type: 'momId', id: momMatch[1] }
    }

    // 2. 匹配 /数字.html 格式（vid）
    const vidMatch = url.match(/\/(\d+)\.html/)
    if (vidMatch) {
      return { type: 'vid', id: vidMatch[1] }
    }

    return null
  }
}

module.exports = HuyaParser
