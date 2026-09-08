/**
 * 西瓜视频解析器
 */
const HttpClient = require('../http')

class XiguaParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析西瓜视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析西瓜视频URL:', url)

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

      // 请求页面HTML
      const reqUrl = `https://m.ixigua.com/douyin/share/video/${videoId}?aweme_type=107&schema_type=1&utm_source=copy&utm_campaign=client_share&utm_medium=android&app=aweme`

      const res = await this.http.request({
        url: reqUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('请求失败，状态码:' + res.statusCode)
      }

      const html = res.data

      // 从HTML中提取 window._ROUTER_DATA
      const videoData = this.extractRouterData(html)
      if (!videoData) {
        throw new Error('无法从HTML中提取视频信息')
      }

      // 解析视频信息
      return this.parseVideoData(videoData)

    } catch (error) {
      console.error('西瓜视频解析失败:', error)
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36'
        }
      })

      if (res.statusCode === 200) {
        const html = res.data
        if (typeof html === 'string') {
          const match = html.match(/<link rel="canonical" href="([^"]+)"/)
          if (match) {
            return match[1]
          }
        }
      }

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
    const match = url.match(/\/video\/([^/?]+)/)
    if (match) {
      return match[1]
    }

    const pathMatch = url.match(/\/([^/?]+)\/?$/)
    if (pathMatch && pathMatch[1] !== 'video') {
      return pathMatch[1]
    }

    return null
  }

  /**
   * 从HTML中提取 window._ROUTER_DATA
   */
  extractRouterData(html) {
    try {
      const pattern = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s
      const match = html.match(pattern)

      if (!match || !match[1]) {
        console.log('未找到 _ROUTER_DATA')
        return null
      }

      const jsonData = JSON.parse(match[1].trim())
      const videoData = jsonData?.loaderData?.['video_(id)/page']?.videoInfoRes?.item_list?.[0]

      if (!videoData) {
        throw new Error('无法获取视频详情')
      }

      return videoData

    } catch (error) {
      console.error('提取 _ROUTER_DATA 失败:', error)
      return null
    }
  }

  /**
   * 解析视频数据
   */
  parseVideoData(data) {
    const result = {
      platform: 'xigua',
      platformName: '西瓜视频',
      type: 'video',
      title: data.desc || '无标题',
      cover: data.video?.cover?.url_list?.[0] || '',
      author: {
        uid: data.author?.user_id || '',
        name: data.author?.nickname || '未知',
        avatar: data.author?.avatar_thumb?.url_list?.[0] || ''
      },
      video: {
        url: data.video?.play_addr?.url_list?.[0] || '',
        urlNoWatermark: data.video?.play_addr?.url_list?.[0] || ''
      }
    }

    console.log('解析成功：视频')
    return result
  }
}

module.exports = XiguaParser
