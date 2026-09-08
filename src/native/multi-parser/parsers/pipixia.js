/**
 * 皮皮虾解析器
 */
const HttpClient = require('../http')

class PipixiaParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析皮皮虾内容
   */
  async parse(url) {
    try {
      console.log('开始解析皮皮虾URL:', url)

      // 1. 如果是短链接，先获取重定向后的完整URL
      let finalUrl = url
      if (url.includes('/s/')) {
        console.log('  检测到短链接格式，尝试获取完整URL...')
        finalUrl = await this.getRedirectUrl(url)
        console.log('  重定向后URL:', finalUrl)
      }

      // 2. 从URL中提取视频ID
      const videoId = this.extractVideoId(finalUrl)
      if (!videoId) {
        throw new Error('无法从分享链接中提取视频ID')
      }

      console.log('  视频ID:', videoId)

      // 3. 尝试多种方法获取视频信息
      let result = null

      // 方法1: 尝试新版API
      try {
        console.log('  📡 尝试新版API...')
        result = await this.getVideoInfoV2(videoId)
        if (result) {
          console.log('  ✅ 新版API解析成功')
          return result
        }
      } catch (err) {
        console.log('  ❌ 新版API失败:', err.message)
      }

      // 方法2: 尝试旧版API
      try {
        console.log('  📡 尝试旧版API...')
        result = await this.getVideoInfoV1(videoId)
        if (result) {
          console.log('  ✅ 旧版API解析成功')
          return result
        }
      } catch (err) {
        console.log('  ❌ 旧版API失败:', err.message)
      }

      // 方法3: 尝试从网页HTML提取
      try {
        console.log('  📡 尝试从网页提取...')
        result = await this.parseFromWeb(finalUrl)
        if (result) {
          console.log('  ✅ 网页解析成功')
          return result
        }
      } catch (err) {
        console.log('  ❌ 网页解析失败:', err.message)
      }

      throw new Error('所有解析方法都失败了，皮皮虾可能已更新接口')

    } catch (error) {
      console.error('皮皮虾解析失败:', error)
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

      // 尝试从响应中提取重定向URL
      // 小程序环境下，重定向会自动跟随，所以检查最终URL
      if (res.statusCode === 200) {
        // 从HTML中提取实际URL
        const html = res.data
        if (typeof html === 'string') {
          const match = html.match(/<link rel="canonical" href="([^"]+)"/)
          if (match) {
            return match[1]
          }
        }
      }

      // 如果没有找到，尝试构造URL
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
    console.log('  🔍 提取视频ID，原始URL:', url)

    // 去除末尾的 # 和 /
    const cleanUrl = url.replace(/[#\/]+$/, '')
    console.log('  🔍 清理后URL:', cleanUrl)

    // 方法1: 提取 /s/ 后面的ID (短链接格式)
    let match = cleanUrl.match(/\/s\/([^/?#]+)/)
    if (match) {
      console.log('  ✅ 通过/s/路径提取到ID:', match[1])
      return match[1]
    }

    // 方法2: 提取 /item/ 后面的ID
    match = cleanUrl.match(/\/item\/([^/?#]+)/)
    if (match) {
      console.log('  ✅ 通过/item/路径提取到ID:', match[1])
      return match[1]
    }

    // 方法3: 尝试提取路径最后部分
    const pathMatch = cleanUrl.match(/\/([^/?#]+)$/)
    if (pathMatch && pathMatch[1] && pathMatch[1] !== 'item' && pathMatch[1] !== 's') {
      console.log('  ✅ 通过路径末尾提取到ID:', pathMatch[1])
      return pathMatch[1]
    }

    console.log('  ❌ 无法提取视频ID')
    return null
  }

  /**
   * 新版API获取视频信息
   */
  async getVideoInfoV2(videoId) {
    try {
      console.log('    📡 调用新版API...')

      // 新版API地址（尝试多个可能的endpoint）
      const apiUrls = [
        `https://is.snssdk.com/bds/cell/detail/?cell_id=${videoId}`,
        `https://h5.pipix.com/bds/webapi/item/detail/?item_id=${videoId}`,
      ]

      for (const apiUrl of apiUrls) {
        try {
          console.log('    尝试API:', apiUrl)

          const res = await this.http.request({
            url: apiUrl,
            method: 'GET',
            header: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
              'Referer': 'https://h5.pipix.com/'
            }
          })

          if (res.statusCode !== 200) {
            continue
          }

          const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

          // 尝试多种可能的数据结构
          const item = jsonData?.data?.item || jsonData?.data?.data

          if (item) {
            return this.parseItemData(item, videoId)
          }
        } catch (err) {
          console.log('    该API失败:', err.message)
          continue
        }
      }

      return null
    } catch (error) {
      console.log('    新版API异常:', error.message)
      return null
    }
  }

  /**
   * 旧版API获取视频信息
   */
  async getVideoInfoV1(videoId) {
    try {
      console.log('    📡 调用旧版API...')

      const apiUrl = `https://api.pipix.com/bds/cell/cell_comment/?offset=0&cell_type=1&api_version=1&cell_id=${videoId}&ac=wifi&channel=huawei_1319_64&aid=1319&app_name=super`

      const res = await this.http.request({
        url: apiUrl,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
        }
      })

      if (res.statusCode !== 200) {
        return null
      }

      const jsonData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
      const data = jsonData?.data?.cell_comments?.[0]?.comment_info?.item

      if (!data) {
        return null
      }

      return this.parseItemData(data, videoId)
    } catch (error) {
      console.log('    旧版API异常:', error.message)
      return null
    }
  }

  /**
   * 从网页HTML中提取数据
   */
  async parseFromWeb(url) {
    try {
      console.log('    📡 请求网页HTML...')

      const res = await this.http.request({
        url: url,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
        }
      })

      if (res.statusCode !== 200 || !res.data) {
        return null
      }

      const html = res.data

      // 尝试从HTML中提取JSON数据
      // 皮皮虾可能在HTML中嵌入 window.__INITIAL_STATE__ 或类似结构
      const patterns = [
        /window\.__INITIAL_STATE__\s*=\s*({.*?});/s,
        /window\.data\s*=\s*({.*?});/s,
        /<script[^>]*>var\s+data\s*=\s*({.*?})<\/script>/s
      ]

      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match) {
          try {
            const jsonData = JSON.parse(match[1])
            console.log('    ✅ 从HTML提取到JSON数据')

            // 尝试多种可能的路径
            const item = jsonData?.item ||
                        jsonData?.itemInfo?.item ||
                        jsonData?.detail?.item ||
                        jsonData?.data?.item

            if (item) {
              return this.parseItemData(item)
            }
          } catch (err) {
            console.log('    JSON解析失败:', err.message)
            continue
          }
        }
      }

      return null
    } catch (error) {
      console.log('    网页解析异常:', error.message)
      return null
    }
  }

  /**
   * 解析item数据（统一的数据解析方法）
   */
  parseItemData(item, videoId = '') {
    const authorId = item.author?.id || item.author?.user_id || ''

    // 解析基础信息
    const result = {
      platform: 'pipixia',
      platformName: '皮皮虾',
      title: item.content || item.title || item.desc || '无标题',
      cover: item.cover?.url_list?.[0]?.url || item.cover?.url || item.origin_cover?.url_list?.[0]?.url || '',
      author: {
        uid: authorId,
        name: item.author?.name || item.author?.nickname || '未知',
        avatar: item.author?.avatar?.download_list?.[0]?.url || item.author?.avatar_thumb?.url_list?.[0]?.url || ''
      },
      videoId: videoId
    }

    // 判断内容类型
    let videoUrl = item.video?.video_high?.url_list?.[0]?.url ||
                  item.video?.play_addr?.url_list?.[0]?.url ||
                  item.video?.download_addr?.url_list?.[0]?.url || ''

    if (videoUrl) {
      // 视频
      result.type = 'video'
      result.video = {
        url: videoUrl,
        urlNoWatermark: videoUrl,
        width: item.video?.width || 0,
        height: item.video?.height || 0,
        duration: item.video?.duration || 0
      }
      console.log('    ✅ 解析成功：视频')
    } else if (item.images && Array.isArray(item.images) && item.images.length > 0) {
      // 图集
      result.type = 'image'
      result.images = item.images.map(img => ({
        url: img.url_list?.[0]?.url || img.url || '',
        width: img.width || 0,
        height: img.height || 0
      }))
      console.log('    ✅ 解析成功：图集，共', result.images.length, '张')
    } else if (item.note?.multi_image && Array.isArray(item.note.multi_image)) {
      // 图集（备用结构）
      result.type = 'image'
      result.images = item.note.multi_image.map(img => ({
        url: img.url_list?.[0]?.url || img.url || '',
        width: img.width || 0,
        height: img.height || 0
      }))
      console.log('    ✅ 解析成功：图集，共', result.images.length, '张')
    } else {
      throw new Error('没有找到视频或图片内容')
    }

    return result
  }
}

module.exports = PipixiaParser
