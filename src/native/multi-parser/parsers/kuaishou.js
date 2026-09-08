/**
 * 快手解析器（参考PHP版本，从HTML中提取数据）
 */
const HttpClient = require('../http')

class KuaishouParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析快手视频
   */
  async parse(url) {
    try {
      console.log('开始解析快手URL:', url)

      // 第一步：获取重定向链接
      console.log('获取重定向链接...')
      const redirectUrl = await this.getRedirectUrl(url)
      console.log('重定向URL:', redirectUrl)

      if (!redirectUrl) {
        throw new Error('无法获取快手重定向链接')
      }

      // 将 /fw/long-video/ 替换为 /fw/photo/（参考PHP版本）
      const finalUrl = redirectUrl.replace('/fw/long-video/', '/fw/photo/')
      console.log('最终URL:', finalUrl)

      // 第二步：获取视频页面HTML
      console.log('请求视频页面...')
      const res = await this.http.request({
        url: finalUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      })

      console.log('页面请求完成，状态码:', res.statusCode)
      console.log('页面数据长度:', res.data ? res.data.length : 0)

      if (res.statusCode !== 200) {
        throw new Error('请求失败，状态码:' + res.statusCode)
      }

      if (!res.data || res.data === '') {
        throw new Error('页面返回空数据')
      }

      const html = res.data

      // 第三步：从HTML中提取 window.INIT_STATE（参考PHP版本）
      console.log('从HTML提取视频数据...')
      const videoData = this.extractInitState(html)

      if (!videoData) {
        throw new Error('无法从页面中提取视频数据')
      }

      // 第四步：解析视频信息
      return this.parseVideoData(videoData)

    } catch (error) {
      console.error('快手解析失败:', error)
      throw error
    }
  }

  /**
   * 获取重定向URL
   */
  async getRedirectUrl(url) {
    try {
      const res = await this.http.request({
        url: url,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
        }
      })

      // 从响应头获取重定向URL
      let location = res.header?.Location || res.header?.location || res.header?.['location']

      if (location) {
        console.log('获取到重定向Location:', location)

        // 如果是相对路径，补全域名
        if (location.startsWith('/')) {
          const urlObj = new URL(url)
          location = `${urlObj.protocol}//${urlObj.host}${location}`
        }

        // 如果是 /short-video/ 路径，可能需要继续跟随重定向
        if (location.includes('/short-video/')) {
          console.log('检测到short-video路径，继续跟随重定向...')
          return await this.getRedirectUrl(location)
        }

        return location
      }

      // 如果没有重定向，尝试从响应内容中提取
      if (res.data && typeof res.data === 'string') {
        // 尝试匹配页面中的跳转链接
        const match = res.data.match(/url=([^&"']+)/)
        if (match) {
          return decodeURIComponent(match[1])
        }
      }

      return url
    } catch (err) {
      console.error('获取重定向URL失败:', err)
      return url
    }
  }

  /**
   * 从HTML中提取 window.INIT_STATE
   */
  extractInitState(html) {
    try {
      console.log('尝试提取 INIT_STATE')

      // 匹配: window.INIT_STATE = {...}</script>
      const pattern = /window\.INIT_STATE\s*=\s*(.*?)<\/script>/s
      const match = html.match(pattern)

      if (!match || !match[1]) {
        console.log('未找到 INIT_STATE')
        return null
      }

      console.log('找到 INIT_STATE，长度:', match[1].length)

      const jsonStr = match[1].trim()
      const jsonData = JSON.parse(jsonStr)

      // 查找包含视频信息的数据（参考PHP版本）
      let videoData = null
      for (const key in jsonData) {
        const item = jsonData[key]
        if (item && item.result && item.photo) {
          videoData = item
          break
        }
      }

      if (!videoData) {
        console.log('INIT_STATE 中未找到视频数据')
        return null
      }

      if (videoData.result != 1) {
        throw new Error('获取作品信息失败: result=' + videoData.result)
      }

      console.log('成功从 INIT_STATE 提取视频数据')
      return videoData.photo

    } catch (error) {
      console.error('提取 INIT_STATE 失败:', error)
      return null
    }
  }

  /**
   * 解析视频数据
   */
  parseVideoData(data) {
    const result = {
      platform: 'kuaishou',
      platformName: '快手',
      type: 'video',
      title: data.caption || '无标题',
      cover: data.coverUrls?.[0]?.url || '',
      author: {
        uid: '',
        name: data.userName || '未知',
        avatar: data.headUrl || ''
      },
      video: {
        url: data.mainMvUrls?.[0]?.url || '',
        urlNoWatermark: data.mainMvUrls?.[0]?.url || '',
        width: data.photoWidth || 0,
        height: data.photoHeight || 0,
        duration: data.duration || 0
      },
      statistics: {
        digg: data.likeCount || 0,
        comment: data.commentCount || 0,
        view: data.viewCount || 0
      },
      createTime: data.timestamp || 0,
      videoId: data.id || ''
    }

    // 解析图集（参考PHP版本）
    const imageCdnHost = data.ext_params?.atlas?.cdn?.[0]
    const imagesList = data.ext_params?.atlas?.list || []

    if (imageCdnHost && imagesList.length > 0) {
      result.type = 'image'
      result.images = imagesList.map(imageId => ({
        url: `https://${imageCdnHost}/${imageId}`,
        width: 0,
        height: 0
      }))
      console.log('解析成功：图集，共', result.images.length, '张')
    } else {
      console.log('解析成功：视频')
    }

    return result
  }
}

module.exports = KuaishouParser
