/**
 * 火山短视频解析器
 */
const HttpClient = require('../http')

class HuoshanParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析火山视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析火山URL:', url)

      // 获取重定向后的URL
      const redirectUrl = await this.getRedirectUrl(url)
      if (!redirectUrl) {
        throw new Error('无法获取重定向链接')
      }

      console.log('重定向URL:', redirectUrl)

      // 从URL中提取视频ID
      const videoId = this.extractVideoId(redirectUrl)
      if (!videoId) {
        throw new Error('无法提取视频ID')
      }

      console.log('视频ID:', videoId)

      // 请求API获取视频数据
      const apiUrl = `https://share.huoshan.com/api/item/info?item_id=${videoId}`

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

      const data = jsonData?.data?.item_info
      if (!data) {
        throw new Error('无法获取视频信息')
      }

      // 解析视频信息
      const result = {
        platform: 'huoshan',
        platformName: '火山',
        type: 'video',
        title: data.title || '无标题',
        cover: data.cover || '',
        author: {
          uid: '',
          name: '未知',
          avatar: ''
        },
        video: {
          url: data.url || '',
          urlNoWatermark: data.url || ''
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('火山解析失败:', error)
      throw error
    }
  }

  /**
   * 获取重定向后的URL
   */
  async getRedirectUrl(url) {
    try {
      const res = await this.http.request({
        url: url,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
        }
      })

      return url

    } catch (error) {
      console.error('获取重定向URL失败:', error)
      return null
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    // 从查询参数中提取 item_id
    const match = url.match(/item_id=([^&]+)/)
    if (match) {
      return match[1]
    }

    return null
  }
}

module.exports = HuoshanParser
