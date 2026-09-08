/**
 * 小红书解析器（参考PHP版本，从HTML中提取数据）
 */
const HttpClient = require('../http')

class XiaohongshuParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析小红书内容
   */
  async parse(url) {
    try {
      console.log('开始解析小红书URL:', url)

      // 请求页面HTML（参考PHP版本）
      console.log('请求页面HTML...')
      const res = await this.http.request({
        url: url,
        method: 'GET',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
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

      // 从HTML中提取 window.__INITIAL_STATE__（参考PHP版本）
      console.log('从HTML提取笔记数据...')
      // 先从 URL 提取 noteId 作为兜底（explore/discovery 页面 __INITIAL_STATE__ 里可能没有 currentNoteId）
      const urlNoteId = (url.match(/\/(?:explore|discovery\/item|note)\/([A-Za-z0-9]{20,})/) || [])[1] || ''
      let noteData = this.extractInitialState(html, urlNoteId)

      // explore 列表页 __INITIAL_STATE__ 里 noteDetailMap 可能为空，用 noteId 调 web API 兜底
      if (!noteData && urlNoteId) {
        console.log('HTML 未含笔记详情，尝试调用小红书笔记详情 API, noteId=' + urlNoteId)
        noteData = await this.fetchNoteByApi(urlNoteId, url)
      }

      if (!noteData) {
        throw new Error('无法从页面中提取笔记数据')
      }

      // 解析笔记信息
      return this.parseNoteData(noteData)

    } catch (error) {
      console.error('小红书解析失败:', error)
      throw error
    }
  }

  /**
   * 通过小红书 web API 获取笔记详情（explore 列表页 HTML 不含笔记详情时的兜底）
   * 使用 sns/web/v1/feed 接口；部分公开笔记无需登录即可返回数据
   */
  async fetchNoteByApi(noteId, sourceUrl) {
    try {
      console.log('调用小红书 feed API, noteId:', noteId)
      const apiUrl = 'https://edith.xiaohongshu.com/api/sns/web/v1/feed'
      const body = JSON.stringify({
        source_note_id: noteId,
        image_formats: ['jpg', 'webp', 'avif'],
        extra: { need_body_topic: 1 },
      })

      const res = await this.http.request({
        url: apiUrl,
        method: 'POST',
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Content-Type': 'application/json;charset=UTF-8',
          'Referer': sourceUrl,
          'Origin': 'https://www.xiaohongshu.com',
          'Accept': 'application/json, text/plain, */*',
        },
        body: body,
        timeout: 15000,
      })

      if (res.statusCode !== 200) {
        console.log('feed API 状态码:', res.statusCode)
        return null
      }

      const json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
      if (!json || json.code !== 0 || !json.data) {
        console.log('feed API 返回 code:', json && json.code, 'msg:', json && json.msg)
        return null
      }

      const items = json.data.items || []
      if (items.length === 0) return null

      const note = items[0].note_card
      if (!note) return null

      console.log('feed API 成功获取笔记详情, title:', (note.title || '').slice(0, 30))
      return note
    } catch (e) {
      console.error('feed API 异常:', e.message)
      return null
    }
  }

  /**
   * 从HTML中提取 window.__INITIAL_STATE__
   * @param {string} urlNoteId 从URL提取的笔记ID兜底（explore页面 __INITIAL_STATE__ 里可能没有 currentNoteId）
   */
  extractInitialState(html, urlNoteId = '') {
    try {
      console.log('尝试提取 __INITIAL_STATE__')

      // 匹配: window.__INITIAL_STATE__ = {...}</script>
      const pattern = /window\.__INITIAL_STATE__\s*=\s*(.*?)<\/script>/s
      const match = html.match(pattern)

      if (!match || !match[1]) {
        console.log('未找到 __INITIAL_STATE__')
        return null
      }

      console.log('找到 __INITIAL_STATE__，长度:', match[1].length)

      let jsonStr = match[1].trim()

      // 清理JSON字符串（处理undefined等非法值）
      // 将 JavaScript 中的 undefined 替换为 null
      jsonStr = jsonStr.replace(/:\s*undefined\s*([,}])/g, ': null$1')

      // 移除末尾的分号（如果有）
      jsonStr = jsonStr.replace(/;+$/, '')

      // 打印调试信息
      console.log('JSON前100字符:', jsonStr.substring(0, 100))
      console.log('JSON后100字符:', jsonStr.substring(jsonStr.length - 100))

      const jsonData = JSON.parse(jsonStr)

      // 获取笔记ID：优先 currentNoteId，其次从 URL 提取，再次用 firstNoteId，最后遍历 noteDetailMap 取第一个
      let noteId = jsonData.note?.currentNoteId
        || urlNoteId
        || jsonData.note?.firstNoteId
        || ''
      if (!noteId && jsonData.note?.noteDetailMap) {
        noteId = Object.keys(jsonData.note.noteDetailMap)[0] || ''
      }
      if (!noteId) {
        throw new Error('无法获取笔记ID')
      }

      console.log('笔记ID:', noteId)

      // 获取笔记详情（参考PHP版本）
      const data = jsonData.note?.noteDetailMap?.[noteId]?.note

      if (!data) {
        throw new Error('无法获取笔记详情')
      }

      console.log('成功从 __INITIAL_STATE__ 提取笔记数据')
      return data

    } catch (error) {
      console.error('提取 __INITIAL_STATE__ 失败:', error)
      console.error('错误详情:', error.message)
      return null
    }
  }

  /**
   * 从流数据中获取最高码率的视频URL
   * 小红书的流分为 h264 和 h265 两种编码，每个编码下可能有多个码率
   * 遍历所有流，按码率（avgBitrate/bitrate）降序，取最高的
   */
  getBestVideoStream(stream) {
    if (!stream) return ''

    const candidates = []

    // 遍历所有编码类型（h264, h265, av1 等）
    for (const codec of Object.keys(stream)) {
      const streams = stream[codec]
      if (!Array.isArray(streams)) continue

      for (const s of streams) {
        if (s.masterUrl || s.master_url) {
          candidates.push({
            url: s.masterUrl || s.master_url,
            bitrate: s.avgBitrate || s.avg_bitrate || s.bitrate || 0,
            codec: codec
          })
        }
      }
    }

    if (candidates.length === 0) return ''

    // 按码率降序排列，取最高
    candidates.sort((a, b) => b.bitrate - a.bitrate)
    console.log('小红书视频流候选:', candidates.map(c => `${c.codec}:${c.bitrate}kbps`).join(', '))
    return candidates[0].url
  }

  /**
   * 解析笔记数据
   */
  parseNoteData(data) {
    const result = {
      platform: 'xiaohongshu',
      platformName: '小红书',
      title: data.title || data.desc || '无标题',
      cover: data.imageList?.[0]?.urlDefault || '',
      author: {
        uid: data.user?.userId || '',
        name: data.user?.nickname || '未知',
        avatar: data.user?.avatar || ''
      },
      statistics: {
        liked: data.interactInfo?.likedCount || 0,
        collected: data.interactInfo?.collectedCount || 0,
        comment: data.interactInfo?.commentCount || 0,
        share: data.interactInfo?.shareCount || 0
      },
      createTime: data.time || 0,
      noteId: data.noteId || ''
    }

    // 视频URL - 遍历所有流（h264/h265），选择最高码率（最高清晰度）
    const videoUrl = this.getBestVideoStream(data.video?.media?.stream)

    // 判断是视频还是图集
    if (videoUrl) {
      // 视频
      result.type = 'video'
      result.video = {
        url: videoUrl,
        urlNoWatermark: videoUrl,
        width: data.video?.width || 0,
        height: data.video?.height || 0,
        duration: data.video?.duration || 0
      }
      console.log('解析成功：视频')
    } else if (data.imageList && data.imageList.length > 0) {
      // 图集
      result.type = 'image'
      result.images = data.imageList.map(imageItem => {
        const imageUrl = imageItem.urlDefault || ''

        // 处理图片URL（参考PHP版本）
        let processedUrl = imageUrl
        if (imageUrl) {
          const lastSlash = imageUrl.lastIndexOf('/')
          if (lastSlash !== -1) {
            const imageIdPart = imageUrl.substring(lastSlash + 1)
            const imgId = imageIdPart.split('!')[0]

            // 检查是否包含 spectrum/
            const spectrumStr = imageUrl.includes('spectrum') ? 'spectrum/' : ''

            // 优化图片URL格式
            if (imageUrl.includes('notes_pre_post')) {
              processedUrl = `https://ci.xiaohongshu.com/notes_pre_post/${spectrumStr}${imgId}?imageView2/format/jpg`
            }
          }
        }

        const imgInfo = {
          url: processedUrl,
          width: imageItem.width || 0,
          height: imageItem.height || 0
        }

        // LivePhoto 支持（参考PHP版本）
        if (imageItem.livePhoto) {
          const h264Stream = imageItem.stream?.h264 || []
          for (const livePhotoItem of h264Stream) {
            if (livePhotoItem.masterUrl) {
              imgInfo.livePhotoUrl = livePhotoItem.masterUrl
              break
            }
          }
        }

        return imgInfo
      })
      console.log('解析成功：图集，共', result.images.length, '张')
    } else {
      throw new Error('没有找到视频或图片内容')
    }

    return result
  }
}

module.exports = XiaohongshuParser

// ===== 可复用的独立函数（供 xhsProfile.js 主页批量下载使用）=====
// 从类中抽出的纯函数，处理 feed API 返回的 note_card（下划线命名），
// 与 parseNoteData 处理的 __INITIAL_STATE__（驼峰）字段不同，故单独导出

/**
 * 从流数据中获取最高码率的视频URL（与类方法逻辑一致）
 * 小红书的流分为 h264 和 h265 等编码，每个编码下可能有多个码率
 */
function pickBestVideoStream(stream) {
  if (!stream) return ''

  const candidates = []

  for (const codec of Object.keys(stream)) {
    const streams = stream[codec]
    if (!Array.isArray(streams)) continue

    for (const s of streams) {
      if (s.masterUrl || s.master_url) {
        candidates.push({
          url: s.masterUrl || s.master_url,
          bitrate: s.avgBitrate || s.avg_bitrate || s.bitrate || 0,
          codec: codec
        })
      }
    }
  }

  if (candidates.length === 0) return ''

  candidates.sort((a, b) => b.bitrate - a.bitrate)
  return candidates[0].url
}

/**
 * 解析 note_card 为统一下载结构
 * 同时兼容两种字段命名：
 *   - feed API（下划线）：note_id / interact_info / image_list / url_default
 *   - 详情页 SSR（驼峰）：noteId / interactInfo / imageList / urlDefault
 * @returns { type:'video'|'image', video?, images?, title, cover, ... }
 */
function parseNoteCard(noteCard) {
  if (!noteCard) throw new Error('笔记数据为空')

  // 兼容取值助手：优先驼峰，其次下划线
  const user = noteCard.user || {}
  const interact = noteCard.interactInfo || noteCard.interact_info || {}
  const cover = noteCard.cover || {}
  const imageList = noteCard.imageList || noteCard.image_list

  const result = {
    platform: 'xiaohongshu',
    platformName: '小红书',
    title: noteCard.title || noteCard.desc || noteCard.displayTitle || '无标题',
    cover: ((cover.urlDefault || cover.url_default || cover.url || (cover.url_list || [])[0]) || '').replace(/^http:\/\//, 'https://'),
    author: {
      uid: user.userId || user.user_id || '',
      name: user.nickname || user.nickName || '未知',
      avatar: user.avatar || ''
    },
    statistics: {
      liked: Number(interact.likedCount || interact.liked_count) || 0,
      collected: Number(interact.collectedCount || interact.collected_count) || 0,
      comment: Number(interact.commentCount || interact.comment_count) || 0,
      share: Number(interact.shareCount || interact.share_count) || 0
    },
    createTime: Number(noteCard.lastUpdateTime || noteCard.last_update_time || noteCard.time) || 0,
    noteId: noteCard.noteId || noteCard.note_id || ''
  }

  // 视频流（video.media.stream 结构两种命名一致，但 masterUrl 是驼峰）
  let videoUrl = pickBestVideoStream(noteCard.video?.media?.stream)
  // 升级 http -> https（小红书 CDN 支持 https）
  if (videoUrl && videoUrl.indexOf('http://') === 0) videoUrl = 'https://' + videoUrl.slice(7)

  if (videoUrl) {
    result.type = 'video'
    result.video = {
      url: videoUrl,
      urlNoWatermark: videoUrl,
      width: noteCard.video?.width || 0,
      height: noteCard.video?.height || 0,
      duration: noteCard.video?.duration || 0
    }
  } else if (Array.isArray(imageList) && imageList.length > 0) {
    // 图集
    result.type = 'image'
    result.images = imageList.map(imageItem => {
      // imageItem 也可能是 Vue ref，解包
      const img = imageItem && imageItem._value !== undefined ? imageItem._value : imageItem
      let imageUrl = img.urlDefault || img.url_default || img.url || ''
      // 升级 http -> https（小红书 CDN 支持 https，避免部分 http URL 被拒或重定向）
      if (imageUrl && imageUrl.indexOf('http://') === 0) imageUrl = 'https://' + imageUrl.slice(7)
      let processedUrl = imageUrl
      // 处理图片URL格式（与类方法一致）
      if (imageUrl) {
        const lastSlash = imageUrl.lastIndexOf('/')
        if (lastSlash !== -1) {
          const imageIdPart = imageUrl.substring(lastSlash + 1)
          const imgId = imageIdPart.split('!')[0]
          const spectrumStr = imageUrl.includes('spectrum') ? 'spectrum/' : ''
          if (imageUrl.includes('notes_pre_post')) {
            processedUrl = `https://ci.xiaohongshu.com/notes_pre_post/${spectrumStr}${imgId}?imageView2/format/jpg`
          }
        }
      }

      const imgInfo = {
        url: processedUrl,
        width: img.width || 0,
        height: img.height || 0
      }

      // LivePhoto
      if (img.live_photo || img.livePhoto) {
        const h264Stream = (img.stream && img.stream.h264) || (img.livePhoto && img.livePhoto.stream && img.livePhoto.stream.h264) || []
        for (const livePhotoItem of h264Stream) {
          if (livePhotoItem.masterUrl || livePhotoItem.master_url) {
            let lpUrl = livePhotoItem.masterUrl || livePhotoItem.master_url
            // 升级 http -> https
            if (lpUrl && lpUrl.indexOf('http://') === 0) lpUrl = 'https://' + lpUrl.slice(7)
            imgInfo.livePhotoUrl = lpUrl
            break
          }
        }
      }

      return imgInfo
    })
  } else {
    throw new Error('没有找到视频或图片内容')
  }

  return result
}
// 追加导出独立函数
module.exports.pickBestVideoStream = pickBestVideoStream
module.exports.parseNoteCard = parseNoteCard
