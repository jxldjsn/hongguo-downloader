/**
 * 度小视（原全民小视频）解析器
 */
const HttpClient = require('../http')

class QuanminParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析度小视视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析度小视URL:', url)

      // 从URL中提取视频ID
      const videoId = this.extractVideoId(url)
      if (!videoId) {
        throw new Error('无法提取视频ID')
      }

      console.log('视频ID:', videoId)

      // 请求API获取视频数据
      const apiUrl = `https://quanmin.hao222.com/wise/growth/api/sv/immerse?source=share-h5&pd=qm_share_mvideo&_format=json&vid=${videoId}`

      const res = await this.http.request({
        url: apiUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('API请求失败，状态码:' + res.statusCode)
      }

      const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

      if ((jsonData.errno || 0) !== 0) {
        throw new Error(jsonData.error || '接口返回错误')
      }

      const statusText = jsonData.data?.meta?.statusText || ''
      if (statusText) {
        throw new Error(statusText)
      }

      const data = jsonData.data
      if (!data) {
        throw new Error('无法获取视频信息')
      }

      // 解析视频信息
      const result = {
        platform: 'quanmin',
        platformName: '度小视',
        type: 'video',
        title: data.meta?.title || data.shareInfo?.title || '无标题',
        cover: data.meta?.image || '',
        author: {
          uid: data.author?.id || '',
          name: data.author?.name || '未知',
          avatar: data.author?.icon || ''
        },
        video: {
          url: data.meta?.video_info?.clarityUrl?.[1]?.url || '',
          urlNoWatermark: data.meta?.video_info?.clarityUrl?.[1]?.url || ''
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('度小视解析失败:', error)
      throw error
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    // 从查询参数中提取 vid
    const match = url.match(/[?&]vid=([^&]+)/)
    if (match) {
      return match[1]
    }

    return null
  }
}

module.exports = QuanminParser
