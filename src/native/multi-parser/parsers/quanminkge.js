/**
 * 全民K歌解析器
 */
const HttpClient = require('../http')

class QuanminkgeParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析全民K歌内容
   */
  async parse(url) {
    try {
      console.log('开始解析全民K歌URL:', url)

      // 从URL中提取歌曲ID
      const videoId = this.extractVideoId(url)
      if (!videoId) {
        throw new Error('无法提取歌曲ID')
      }

      console.log('歌曲ID:', videoId)

      // 请求页面HTML
      const reqUrl = `https://kg.qq.com/node/play?s=${videoId}`

      const res = await this.http.request({
        url: reqUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Safari/537.36 Edg/104.0.1293.70'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('请求失败，状态码:' + res.statusCode)
      }

      const html = res.data

      // 提取 window.__DATA__
      const match = html.match(/window\.__DATA__\s*=\s*(.*?);/)
      if (!match || !match[1]) {
        throw new Error('无法从HTML中提取数据')
      }

      const jsonData = JSON.parse(match[1].trim())
      const data = jsonData?.detail
      if (!data) {
        throw new Error('无法获取歌曲信息')
      }

      // 解析信息
      const result = {
        platform: 'quanminkge',
        platformName: '全民K歌',
        type: 'video',
        title: data.content || '无标题',
        cover: data.cover || '',
        author: {
          uid: data.uid || '',
          name: data.nick || '未知',
          avatar: data.avatar || ''
        },
        video: {
          url: data.playurl_video || '',
          urlNoWatermark: data.playurl_video || ''
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('全民K歌解析失败:', error)
      throw error
    }
  }

  /**
   * 从URL中提取歌曲ID
   */
  extractVideoId(url) {
    // 从查询参数中提取 s
    const match = url.match(/[?&]s=([^&]+)/)
    if (match) {
      return match[1]
    }

    return null
  }
}

module.exports = QuanminkgeParser
