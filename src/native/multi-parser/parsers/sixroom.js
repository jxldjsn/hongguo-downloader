/**
 * 六间房解析器
 */
const HttpClient = require('../http')

class SixroomParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析六间房视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析六间房URL:', url)

      // 从URL中提取视频ID
      const videoId = this.extractVideoId(url)
      if (!videoId) {
        throw new Error('无法提取视频ID')
      }

      console.log('视频ID:', videoId)

      // 请求API获取视频数据
      const apiUrl = `https://v.6.cn/coop/mobile/index.php?padapi=minivideo-watchVideo.php&av=3.0&encpass=&logiuid=&isnew=1&from=0&vid=${videoId}`

      const res = await this.http.request({
        url: apiUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
          'Referer': `https://m.6.cn/v/${videoId}`
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('API请求失败，状态码:' + res.statusCode)
      }

      const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

      const data = jsonData?.content
      if (!data) {
        throw new Error('无法获取视频信息')
      }

      // 解析视频信息
      const result = {
        platform: 'sixroom',
        platformName: '六间房',
        type: 'video',
        title: data.title || '无标题',
        cover: data.picurl || '',
        author: {
          uid: '',
          name: data.alias || '未知',
          avatar: data.picuser || ''
        },
        video: {
          url: data.playurl || '',
          urlNoWatermark: data.playurl || ''
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('六间房解析失败:', error)
      throw error
    }
  }

  /**
   * 从URL中提取视频ID
   * 支持格式：
   *   1. https://v.6.cn/948828        -> 路径首段就是 ID（注意：v.6.cn 域名里也有 v，不能误匹配）
   *   2. https://m.6.cn/v/948828      -> /v/数字
   *   3. ...?vid=948828               -> 查询参数
   */
  extractVideoId(url) {
    // 从查询参数中提取 vid
    const vidMatch = url.match(/[?&]vid=([^&]+)/)
    if (vidMatch) {
      return vidMatch[1]
    }

    // 从路径中提取 /v/视频ID（兼容 m.6.cn/v/123）
    const pathMatch = url.match(/\/v\/([^/?]+)/)
    if (pathMatch) {
      return pathMatch[1]
    }

    // v.6.cn/数字 格式：取域名后的第一段路径（去掉 .html 等扩展名后缀）
    const vCnMatch = url.match(/v\.6\.cn\/([^/?#]+)/)
    if (vCnMatch) {
      return vCnMatch[1].replace(/\.\w+$/, '')
    }

    return null
  }
}

module.exports = SixroomParser
