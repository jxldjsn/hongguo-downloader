/**
 * TikTok 解析器
 *
 * 使用第三方 tikwm.com API 解析 TikTok 视频。
 * 优点：无需登录、无需代理、无需 X-Bogus/msToken/ttwid 签名，0.6s 返回无水印 HD 直链。
 * 限制：仅支持单视频解析，不支持用户主页视频列表（需官方 API 三重签名，暂未实现）。
 *
 * API: GET https://www.tikwm.com/api/?url=<tiktok链接>&hd=1
 * 返回: { code:0, data:{ hdplay, play, wmplay, cover, music, author:{id,unique_id,nickname,avatar},
 *                       duration, title, play_count, digg_count, comment_count, share_count, ... } }
 */
const HttpClient = require('../http')

class TiktokParser {
  constructor() {
    this.http = new HttpClient()
    this.api = 'https://www.tikwm.com/api/'
  }

  /**
   * 解析 TikTok 视频
   */
  async parse(url) {
    try {
      console.log('🎬 TikTok 解析器开始工作')
      console.log('  - 输入URL:', url)

      // tikwm 接受原始 TikTok 链接（含短链 vm.tiktok.com / vt.tiktok.com），
      // 由它服务端做重定向解析，本地无需先解析短链。
      const data = await this.requestData(url)
      if (!data) {
        throw new Error('tikwm 返回数据为空')
      }

      console.log('  ✅ TikTok 解析完成')
      return this.mapToStandard(data)
    } catch (error) {
      console.error('❌ TikTok 解析失败:', error.message)
      throw error
    }
  }

  /**
   * 请求 tikwm API（带重试，无需代理）
   */
  async requestData(url, retry = 2) {
    let lastErr
    for (let i = 0; i <= retry; i++) {
      try {
        console.log(`  📡 请求 tikwm API（第${i + 1}次）...`)
        const res = await this.http.get(this.api, { url, hd: '1' }, {
          header: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.tikwm.com/'
          }
        })

        if (res.statusCode !== 200) {
          throw new Error(`tikwm HTTP ${res.statusCode}`)
        }

        const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
        if (!body || body.code !== 0 || !body.data) {
          const msg = body?.msg || '未知错误'
          throw new Error(`tikwm 返回错误: ${msg}`)
        }

        console.log('  ✅ tikwm 返回成功')
        return body.data
      } catch (e) {
        lastErr = e
        console.warn(`  ⚠️ 第${i + 1}次失败: ${e.message}`)
        if (i < retry) {
          await new Promise(r => setTimeout(r, 800))
        }
      }
    }
    throw lastErr || new Error('tikwm 请求失败')
  }

  /**
   * 将 tikwm 返回映射为解析器标准格式
   */
  mapToStandard(data) {
    const author = data.author || {}
    const stats = data.statistics || {}
    // tikwm 的 hdplay 是无水印 HD 直链；play 是标准清晰度；wmplay 是带水印
    const videoUrl = data.hdplay || data.play || data.wmplay || ''

    return {
      platform: 'tiktok',
      platformName: 'TikTok',
      type: 'video',
      title: data.title || '',
      cover: data.cover || '',
      desc: data.title || '',
      author: {
        uid: String(author.id || ''),
        name: author.nickname || author.unique_id || '',
        avatar: author.avatar || ''
      },
      video: {
        url: videoUrl,
        urlNoWatermark: data.hdplay || videoUrl,
        duration: data.duration || 0,
        // 不设 isDash/isYtdl/audioUrl -> 走 download-file 直链下载
      },
      statistics: {
        view: stats.play_count || data.play_count || 0,
        like: stats.digg_count || data.digg_count || 0,
        comment: stats.comment_count || data.comment_count || 0,
        share: stats.share_count || data.share_count || 0
      },
      music: {
        title: data.music_info?.title || '',
        author: data.music_info?.author || '',
        url: data.music || ''
      },
      createTime: data.create_time || 0
    }
  }
}

module.exports = TiktokParser
