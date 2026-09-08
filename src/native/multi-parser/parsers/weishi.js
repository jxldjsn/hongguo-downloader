/**
 * 微视解析器
 */
const HttpClient = require('../http')

class WeishiParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析微视视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析微视URL:', url)

      // 从URL中提取视频ID
      const videoId = this.extractVideoId(url)
      if (!videoId) {
        throw new Error('无法从链接中提取视频ID')
      }

      console.log('视频ID:', videoId)

      // 请求API获取视频数据
      const apiUrl = `https://h5.weishi.qq.com/webapp/json/weishi/WSH5GetPlayPage?feedid=${videoId}`

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

      if (!jsonData || jsonData.ret !== 0) {
        throw new Error(jsonData?.msg || '获取视频信息失败')
      }

      const errMsg = jsonData.data?.errmsg || ''
      if (errMsg) {
        throw new Error(errMsg)
      }

      const data = jsonData.data?.feeds?.[0]
      if (!data) {
        throw new Error('无法获取视频详情')
      }

      // 解析视频信息
      const result = {
        platform: 'weishi',
        platformName: '微视',
        type: 'video',
        title: data.feed_desc_withat || '无标题',
        cover: data.images?.[0]?.url || '',
        author: {
          uid: '',
          name: data.poster?.nick || '未知',
          avatar: data.poster?.avatar || ''
        },
        video: {
          url: data.video_url || '',
          urlNoWatermark: data.video_url || ''
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('微视解析失败:', error)
      throw error
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    // 从查询参数中提取 id
    const match = url.match(/[?&]id=([^&]+)/)
    if (match) {
      return match[1]
    }

    return null
  }
}

module.exports = WeishiParser
