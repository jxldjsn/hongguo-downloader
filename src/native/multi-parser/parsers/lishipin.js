/**
 * 梨视频解析器
 */
const HttpClient = require('../http')

class LishipinParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析梨视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析梨视频URL:', url)

      // 从URL中提取视频ID
      const videoId = this.extractVideoId(url)
      if (!videoId) {
        throw new Error('无法提取视频ID')
      }

      console.log('视频ID:', videoId)

      // 请求API获取视频数据
      const timestamp = Date.now()
      const apiUrl = `https://www.pearvideo.com/videoStatus.jsp?contId=${videoId}&mrd=${timestamp}`

      const res = await this.http.request({
        url: apiUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36',
          'Referer': `https://www.pearvideo.com/detail_${videoId}`
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('API请求失败，状态码:' + res.statusCode)
      }

      const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

      const data = jsonData?.videoInfo
      if (!data) {
        throw new Error('无法获取视频信息')
      }

      const videoSrcUrl = data.videos?.srcUrl || ''
      const timer = jsonData.systemTime || ''

      // 替换时间戳为视频ID
      const videoUrl = videoSrcUrl.replace(timer, `cont-${videoId}`)

      // 解析视频信息
      const result = {
        platform: 'lishipin',
        platformName: '梨视频',
        type: 'video',
        title: '梨视频',
        cover: data.video_image || '',
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

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('梨视频解析失败:', error)
      throw error
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    // 匹配 /detail_视频ID 或 /video_视频ID 格式
    const match = url.match(/\/(?:detail|video)_(\d+)/)
    if (match) {
      return match[1]
    }

    return null
  }
}

module.exports = LishipinParser
