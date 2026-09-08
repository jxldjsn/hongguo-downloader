/**
 * 美拍解析器
 */
const HttpClient = require('../http')

class MeipaiParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析美拍视频内容
   */
  async parse(url) {
    try {
      console.log('开始解析美拍URL:', url)

      // 请求页面HTML
      const res = await this.http.request({
        url: url,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36'
        }
      })

      if (res.statusCode !== 200) {
        throw new Error('请求失败，状态码:' + res.statusCode)
      }

      const html = res.data

      // 提取视频的base64数据
      const videoMatch = html.match(/id=["']shareMediaBtn["'][^>]*data-video=["']([^"']+)["']/)
      if (!videoMatch || !videoMatch[1]) {
        throw new Error('无法提取视频数据')
      }

      const videoBs64 = videoMatch[1]
      const videoUrl = this.parseVideoBs64(videoBs64)

      // 提取封面
      const coverMatch = html.match(/id=["']detailVideo["'][^>]*>.*?<img[^>]+src=["']([^"']+)["']/)
      const coverUrl = coverMatch ? coverMatch[1] : ''

      // 提取标题
      const titleMatch = html.match(/<[^>]*class=["'][^"']*detail-cover-title[^"']*["'][^>]*>([^<]+)</)
      const title = titleMatch ? titleMatch[1].trim() : '无标题'

      // 提取作者信息
      const nameMatch = html.match(/<[^>]*class=["']detail-avatar["'][^>]*alt=["']([^"']+)["']/)
      const avatarMatch = html.match(/<[^>]*class=["']detail-avatar["'][^>]*src=["']([^"']+)["']/)

      // 解析视频信息
      const result = {
        platform: 'meipai',
        platformName: '美拍',
        type: 'video',
        title: title,
        cover: coverUrl,
        author: {
          uid: '',
          name: nameMatch ? nameMatch[1] : '未知',
          avatar: avatarMatch ? 'https:' + avatarMatch[1] : ''
        },
        video: {
          url: videoUrl,
          urlNoWatermark: videoUrl
        }
      }

      console.log('解析成功：视频')
      return result

    } catch (error) {
      console.error('美拍解析失败:', error)
      throw error
    }
  }

  /**
   * 解析美拍视频的base64编码
   */
  parseVideoBs64(videoBs64) {
    const hex = this.getHex(videoBs64)
    const dec = this.getDec(hex.hex_1)
    const d = this.subStr(hex.str_1, dec.pre)
    const p = this.getPos(d, dec.tail)
    const kk = this.subStr(d, p)
    const decodeBs64 = this.base64Decode(kk)
    return 'https:' + decodeBs64
  }

  getHex(s) {
    const hex = s.substring(0, 4)
    const str = s.substring(4)
    return {
      hex_1: hex.split('').reverse().join(''),
      str_1: str
    }
  }

  getDec(hex) {
    const n = parseInt(hex, 16)
    const length = String(n).length
    const pre = []
    const tail = []

    let tmpN = n
    for (let i = 0; i <= length - 1; i++) {
      const tmp = tmpN % 10
      tmpN = Math.floor((tmpN - tmp) / 10)
      if (i >= length - 2) {
        pre.unshift(tmp)
      } else {
        tail.unshift(tmp)
      }
    }

    return { pre, tail }
  }

  subStr(s, b) {
    if (b.length < 2) {
      throw new Error('substr参数错误')
    }
    const c = s.substring(0, b[0])
    const d = s.substring(b[0], b[0] + b[1])
    const temp = s.substring(b[0]).replace(d, '')
    return c + temp
  }

  getPos(s, b) {
    if (b.length < 2) {
      throw new Error('getPos参数错误')
    }
    b[0] = s.length - b[0] - b[1]
    return b
  }

  base64Decode(str) {
    // 简单的base64解码（uni-app环境可能需要使用其他方法）
    try {
      return decodeURIComponent(escape(atob(str)))
    } catch (e) {
      // 如果atob不可用，返回原始字符串
      return str
    }
  }
}

module.exports = MeipaiParser
