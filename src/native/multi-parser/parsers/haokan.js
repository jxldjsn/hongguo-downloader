/**
 * 好看视频解析器
 */
const HttpClient = require('../http')

class HaokanParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析好看视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析好看视频URL:', url)

      // 从URL中提取视频ID
      const videoId = this.extractVideoId(url)
      if (!videoId) {
        throw new Error('无法提取视频ID')
      }

      console.log('视频ID:', videoId)

      // 请求API获取视频数据
      const apiUrl = `https://haokan.baidu.com/v?_format=json&vid=${videoId}`

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

      const data = jsonData.data?.apiData?.curVideoMeta
      if (!data) {
        throw new Error('无法获取视频信息')
      }

      // 从 clarityUrl 数组中选最高清晰度（rank 最大）
      // clarityUrl 格式：[{key, rank, title, url, videoBps, vodVideoHW...}]
      // rank 越大清晰度越高（0=标清, 1=高清, 2=超清）
      let bestVideoUrl = data.playurl || ''
      let bestClarity = ''
      if (Array.isArray(data.clarityUrl) && data.clarityUrl.length > 0) {
        const sorted = data.clarityUrl.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0))
        const best = sorted[0]
        if (best && best.url) {
          bestVideoUrl = best.url
          bestClarity = best.title || ''
        }
      }

      // 解析视频信息
      const result = {
        platform: 'haokan',
        platformName: '好看视频',
        type: 'video',
        title: data.title || '无标题',
        cover: data.poster || '',
        author: {
          uid: data.mth?.mthid || '',
          name: data.mth?.author_name || '未知',
          avatar: data.mth?.author_photo || ''
        },
        video: {
          url: bestVideoUrl,
          urlNoWatermark: bestVideoUrl,
          quality: bestClarity
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('好看视频解析失败:', error)
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

    // mbd.baidu.com 落地页格式：?nid=sv_8071172452674558009
    // nid 带 sv_ 前缀，去掉前缀即为 vid
    const nidMatch = url.match(/[?&]nid=sv_(\d+)/)
    if (nidMatch) {
      return nidMatch[1]
    }

    return null
  }
}

module.exports = HaokanParser
