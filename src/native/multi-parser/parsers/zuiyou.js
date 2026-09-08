/**
 * 最右解析器
 */
const HttpClient = require('../http')

class ZuiyouParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析最右视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析最右URL:', url)

      // 从URL中提取视频ID
      const pid = this.extractVideoId(url)
      if (!pid) {
        throw new Error('无法从链接中提取视频ID')
      }

      console.log('视频ID:', pid)

      // 请求API获取视频数据
      const apiUrl = 'https://share.xiaochuankeji.cn/planck/share/post/detail_h5'

      const res = await this.http.request({
        url: apiUrl,
        method: 'POST',
        data: {
          h_av: '5.2.13.011',
          pid: parseInt(pid)
        },
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
          'Content-Type': 'application/json'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('API请求失败，状态码:' + res.statusCode)
      }

      const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

      const data = jsonData?.data?.post
      if (!data) {
        throw new Error('无法获取视频详情')
      }

      const videoKey = data.imgs?.[0]?.id || ''

      // 解析视频信息
      const result = {
        platform: 'zuiyou',
        platformName: '最右',
        type: 'video',
        title: data.content || '无标题',
        cover: data.videos?.[videoKey]?.cover_urls?.[0] || '',
        author: {
          uid: '',
          name: data.member?.name || '未知',
          avatar: data.member?.avatar_urls?.origin?.urls?.[0] || ''
        },
        video: {
          url: data.videos?.[videoKey]?.url || '',
          urlNoWatermark: data.videos?.[videoKey]?.url || ''
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('最右解析失败:', error)
      throw error
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    // 从查询参数中提取 pid
    const match = url.match(/[?&]pid=([^&]+)/)
    if (match) {
      return match[1]
    }

    return null
  }
}

module.exports = ZuiyouParser
