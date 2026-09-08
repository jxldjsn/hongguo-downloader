/**
 * A站（AcFun）解析器
 */
const HttpClient = require('../http')

class AcfunParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析A站视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析A站URL:', url)

      // 请求页面HTML
      const res = await this.http.request({
        url: url,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('请求失败，状态码:' + res.statusCode)
      }

      const html = res.data

      // 提取 videoInfo
      const videoInfoMatch = html.match(/var videoInfo\s*=\s*(.*?);/)
      let title = '无标题'
      let cover = ''

      if (videoInfoMatch && videoInfoMatch[1]) {
        try {
          const videoInfo = JSON.parse(videoInfoMatch[1].trim())
          title = videoInfo.title || title
          cover = videoInfo.cover || cover
        } catch (e) {
          console.error('解析 videoInfo 失败:', e)
        }
      }

      // 提取 playInfo
      const playInfoMatch = html.match(/var playInfo\s*=\s*(.*?);/)
      let videoUrl = ''

      if (playInfoMatch && playInfoMatch[1]) {
        try {
          const playInfo = JSON.parse(playInfoMatch[1].trim())
          videoUrl = playInfo.streams?.[0]?.playUrls?.[0] || ''
        } catch (e) {
          console.error('解析 playInfo 失败:', e)
        }
      }

      if (!videoUrl) {
        throw new Error('无法获取视频地址')
      }

      // 解析视频信息
      const result = {
        platform: 'acfun',
        platformName: 'A站',
        type: 'video',
        title: title,
        cover: cover,
        author: {
          uid: '',
          name: '未知',
          avatar: ''
        },
        video: {
          url: videoUrl,
          urlNoWatermark: videoUrl
        }
      }

      console.log('解析成功：视频 (注意：A站视频通常是m3u8格式)')
      return result

    } catch (error) {
      console.error('A站解析失败:', error)
      throw error
    }
  }
}

module.exports = AcfunParser
