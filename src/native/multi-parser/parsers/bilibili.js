/**
 * 哔哩哔哩解析器
 */
const HttpClient = require('../http')

class BilibiliParser {
  constructor() {
    this.http = new HttpClient()
  }

  /**
   * 解析B站内容（视频或图集）
   */
  async parse(url) {
    try {
      console.log('🎬 B站解析器开始工作')
      console.log('  - 输入URL:', url)

      // 1. 处理短链接
      let finalUrl = url
      let shortLinkHtml = null
      if (url.includes('b23.tv')) {
        console.log('  ⏳ 检测到短链接，正在重定向...')
        const redirectResult = await this.getFinalUrl(url)
        finalUrl = redirectResult.url
        shortLinkHtml = redirectResult.html
        console.log('  ✅ 重定向后URL:', finalUrl)
      }

      // 2. 判断内容类型（视频、图集、动态等）
      const contentType = this.detectContentType(finalUrl, shortLinkHtml)
      console.log('  📋 内容类型:', contentType)

      if (contentType === 'opus' || contentType === 'dynamic') {
        // 图集/动态
        console.log('  🖼️ 检测到图集/动态，开始提取...')
        return await this.parseOpus(finalUrl, shortLinkHtml)
      } else {
        // 视频
        console.log('  🎥 检测到视频，开始解析...')
        return await this.parseVideo(finalUrl, shortLinkHtml)
      }
    } catch (error) {
      console.error('❌ B站解析失败:', error.message)
      console.error('  - 输入URL:', url)
      console.error('  - 错误堆栈:', error.stack)
      throw error
    }
  }

  /**
   * 检测内容类型
   */
  detectContentType(url, html) {
    // 检查URL中的关键词
    if (url.includes('/opus/') || url.includes('t.bilibili.com')) {
      return 'opus'
    }
    if (url.includes('/video/')) {
      return 'video'
    }

    // 从HTML中检测
    if (html) {
      if (html.includes('/opus/') || html.includes('class="opus')) {
        return 'opus'
      }
      if (html.includes('/video/')) {
        return 'video'
      }
      // 检查是否包含图片相关的meta标签
      if (html.match(/<meta[^>]*property=["']og:type["'][^>]*content=["']article["']/)) {
        return 'opus'
      }
    }

    return 'video' // 默认当作视频处理
  }

  /**
   * 解析视频
   */
  async parseVideo(finalUrl, shortLinkHtml) {
    // 2. 提取视频BV号或AV号
    console.log('  🔍 开始提取视频ID...')
    let videoId = this.extractVideoId(finalUrl)

    // 如果从URL无法提取，尝试从短链接HTML中提取
    if (!videoId && shortLinkHtml) {
      console.log('  🔍 尝试从短链接HTML中提取视频ID...')
      videoId = this.extractVideoIdFromHtml(shortLinkHtml)
    }

    if (!videoId) {
      console.error('  ❌ 无法从URL提取视频ID')
      console.error('  URL:', finalUrl)
      console.error('  可能原因:')
      console.error('    1. URL格式不正确')
      console.error('    2. 不包含BV号或AV号')
      console.error('    3. 链接已过期或无效')
      throw new Error('无法提取视频ID')
    }
    console.log('  ✅ 提取到视频ID:', videoId)

    // 3. 获取视频信息
    console.log('  📡 开始获取视频信息...')
    const videoInfo = await this.getVideoInfo(videoId)
    console.log('  ✅ B站视频解析完成')

    return videoInfo
  }

  /**
   * 解析图集/动态
   */
  async parseOpus(finalUrl, html) {
    console.log('  🖼️ 开始解析B站图集/动态...')

    // 从HTML中提取opus ID
    let opusId = null

    // 从URL提取
    const urlMatch = finalUrl.match(/\/opus\/(\d+)/)
    if (urlMatch) {
      opusId = urlMatch[1]
    }

    // 从HTML提取
    if (!opusId && html) {
      const patterns = [
        /\/opus\/(\d+)/,
        /"opus_id["\s:]+(\d+)/i,
        /"id["\s:]+(\d+)/,
        /t\.bilibili\.com\/(\d+)/
      ]

      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match) {
          opusId = match[1]
          console.log('  ✅ 从HTML提取到opus ID:', opusId)
          break
        }
      }
    }

    if (!opusId) {
      throw new Error('无法提取图集ID，该链接可能不是B站图集')
    }

    console.log('  ✅ 图集ID:', opusId)

    // 获取图集信息
    return await this.getOpusInfo(opusId, html)
  }

  /**
   * 获取图集信息
   */
  async getOpusInfo(opusId, html) {
    try {
      console.log('  📡 正在获取图集信息...')

      // 优先尝试从HTML中提取（避免风控）
      if (html) {
        console.log('  🔍 尝试从HTML中提取图片...')
        const htmlResult = this.extractImagesFromHtml(html)
        if (htmlResult && htmlResult.images.length > 0) {
          console.log('  ✅ 从HTML提取成功，图片数量:', htmlResult.images.length)
          return htmlResult
        }
      }

      // 备用方案：调用API
      console.log('  📡 从HTML提取失败，尝试API方式...')
      const apiUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${opusId}`
      console.log('  API地址:', apiUrl)

      const res = await this.http.get(apiUrl, {}, {
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.bilibili.com/',
          'Origin': 'https://www.bilibili.com',
          'Accept': 'application/json, text/plain, */*'
        }
      })

      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
      console.log('  API返回code:', data.code)

      if (data.code !== 0 || !data.data) {
        console.error('  ❌ API返回错误, code:', data.code)
        console.error('  可能是风控限制，请稍后重试')
        throw new Error('API调用失败，请稍后重试')
      }

      const item = data.data.item
      const modules = item.modules || {}
      const author = modules.module_author || {}
      const dynamic = modules.module_dynamic || {}
      const major = dynamic.major || {}

      console.log('  ✅ 获取图集信息成功')

      // 提取图片列表
      const images = []
      if (major.opus && major.opus.pics) {
        for (const pic of major.opus.pics) {
          images.push({
            url: pic.url,
            width: pic.width,
            height: pic.height,
            size: pic.size
          })
        }
      }

      console.log('  📷 图片数量:', images.length)

      return {
        platform: 'bilibili',
        platformName: '哔哩哔哩',
        type: 'image',
        title: major.opus?.summary || dynamic.desc?.text || '无标题',
        cover: images[0]?.url || '',
        desc: dynamic.desc?.text || '',
        author: {
          uid: String(author.mid || ''),
          name: author.name || '',
          avatar: author.face || ''
        },
        images: images,
        statistics: {
          view: item.basic?.view_str || '0',
          like: item.basic?.like_icon?.count || 0,
          share: item.basic?.share_icon?.count || 0
        },
        createTime: item.basic?.pub_ts || 0,
        opusId: opusId
      }
    } catch (error) {
      console.error('  ❌ 获取图集信息失败:', error.message)
      throw new Error('解析失败: ' + error.message)
    }
  }

  /**
   * 从HTML中提取图片信息
   */
  extractImagesFromHtml(html) {
    try {
      console.log('  🔍 开始从HTML提取图片信息...')

      if (!html) {
        console.log('  ❌ HTML为空')
        return null
      }

      const images = []
      let title = '无标题'
      let desc = ''
      let author = { uid: '', name: '', avatar: '' }

      // 方法1: 从HTML标签直接提取图片（最简单直接）
      console.log('  🔍 方法1: 从HTML标签提取图片...')
      const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*class=["'][^"']*b-img__inner[^"']*["']/gi
      let match
      while ((match = imgRegex.exec(html)) !== null) {
        let imgUrl = match[1]
        // 处理协议相对URL
        if (imgUrl.startsWith('//')) {
          imgUrl = 'https:' + imgUrl
        }
        // 去掉图片处理参数（@1192w等）
        imgUrl = imgUrl.replace(/@\w+$/, '')

        console.log('    ✅ 找到图片:', imgUrl)
        images.push({
          url: imgUrl,
          width: 0,
          height: 0,
          size: 0
        })
      }

      if (images.length > 0) {
        console.log('  ✅ 从HTML标签提取到', images.length, '张图片')

        // 提取标题
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
        if (titleMatch) {
          title = titleMatch[1].replace(' - 哔哩哔哩', '').trim()
        }

        return {
          platform: 'bilibili',
          platformName: '哔哩哔哩',
          type: 'image',
          title: title,
          cover: images[0]?.url || '',
          desc: desc,
          author: author,
          images: images,
          statistics: {
            view: '未知',
            like: 0,
            share: 0
          },
          createTime: 0,
          opusId: ''
        }
      }

      // 方法2: 从__INITIAL_STATE__提取（备用）
      console.log('  🔍 方法2: 从__INITIAL_STATE__提取...')
      const scriptMatch = html.match(/<script[^>]*>window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;\s*\(function/i)
      if (!scriptMatch) {
        console.log('  ⚠️ 未找到__INITIAL_STATE__数据')
        return null
      }

      const jsonStr = scriptMatch[1]
      console.log('  ✅ 找到状态数据，长度:', jsonStr.length)

      const state = JSON.parse(jsonStr)
      console.log('  ✅ JSON解析成功')
      console.log('  📋 State顶层键:', Object.keys(state).join(', '))

      // 尝试多种可能的数据结构
      if (state.opus) {
        console.log('  ✅ 找到state.opus')
        console.log('  📋 opus键:', Object.keys(state.opus).join(', '))

        // 检查opus下的内容
        if (state.opus.pics) {
          console.log('  ✅ 找到state.opus.pics')
          // 直接在opus下
          for (const pic of state.opus.pics) {
            images.push({
              url: pic.url,
              width: pic.width || 0,
              height: pic.height || 0,
              size: pic.size || 0
            })
          }
          title = state.opus.summary || state.opus.title || title
          desc = state.opus.content || desc
        } else if (state.opus.detail) {
          console.log('  ✅ 找到state.opus.detail')
          console.log('  📋 opus.detail键:', Object.keys(state.opus.detail).join(', '))

          const detail = state.opus.detail

          // modules是一个数组
          if (detail.modules && Array.isArray(detail.modules)) {
            console.log('  ✅ 找到opus.detail.modules数组，长度:', detail.modules.length)

            // 遍历modules数组，寻找图片模块
            for (const module of detail.modules) {
              console.log('  🔍 检查模块类型:', module.module_type)

              // 打印模块的所有键
              console.log('    📋 模块键:', Object.keys(module).join(', '))

              // 寻找内容模块（可能包含图片）
              if (module.module_content) {
                console.log('  ✅ 找到module_content')
                const content = module.module_content
                console.log('    📋 content键:', Object.keys(content).join(', '))

                // 检查paragraphs
                if (content.paragraphs && Array.isArray(content.paragraphs)) {
                  console.log('  ✅ 找到content.paragraphs数组，长度:', content.paragraphs.length)

                  let firstPicLogged = false // 只打印第一张图片的详细信息

                  for (const para of content.paragraphs) {
                    // 只打印类型，不打印所有键
                    // console.log('    🔍 段落类型:', para.para_type)

                    // 检查图片段落
                    if (para.pic) {
                      if (!firstPicLogged) {
                        console.log('    ✅ 找到第一个图片段落')
                        console.log('    📋 pic键:', Object.keys(para.pic).join(', '))
                        firstPicLogged = true
                      }

                      // 提取图片URL - pic.pics是数组
                      if (para.pic.pics && Array.isArray(para.pic.pics)) {
                        for (const picItem of para.pic.pics) {
                          images.push({
                            url: picItem.url || '',
                            width: picItem.width || 0,
                            height: picItem.height || 0,
                            size: picItem.size || 0
                          })
                        }
                      }
                    }

                    // 检查文本段落
                    if (para.text && para.text.text) {
                      desc += para.text.text
                    }
                  }
                }

                // 检查是否有opus（备用）
                if (content.opus) {
                  console.log('  ✅ 找到content.opus')
                  console.log('    📋 opus键:', Object.keys(content.opus).join(', '))

                  if (content.opus.pics) {
                    console.log('  ✅ 找到content.opus.pics，图片数量:', content.opus.pics.length)
                    for (const pic of content.opus.pics) {
                      images.push({
                        url: pic.url,
                        width: pic.width || 0,
                        height: pic.height || 0,
                        size: pic.size || 0
                      })
                    }
                    title = content.opus.summary || title
                    desc = content.opus.content || desc
                  }
                }
              }

              // 寻找动态内容模块
              if (module.module_dynamic) {
                const dynamic = module.module_dynamic
                console.log('  ✅ 找到module_dynamic')

                if (dynamic.major) {
                  console.log('  ✅ 找到major')
                  const major = dynamic.major
                  console.log('  📋 major键:', Object.keys(major).join(', '))

                  if (major.opus && major.opus.pics) {
                    console.log('  ✅ 找到major.opus.pics，图片数量:', major.opus.pics.length)
                    for (const pic of major.opus.pics) {
                      images.push({
                        url: pic.url,
                        width: pic.width || 0,
                        height: pic.height || 0,
                        size: pic.size || 0
                      })
                    }
                    title = major.opus.summary || title
                  }
                }

                // 提取描述
                if (dynamic.desc) {
                  desc = dynamic.desc.text || desc
                }
              }

              // 寻找作者模块
              if (module.module_author) {
                author = {
                  uid: String(module.module_author.mid || ''),
                  name: module.module_author.name || '',
                  avatar: module.module_author.face || ''
                }
              }

              // 寻找标题模块
              if (module.module_title) {
                title = module.module_title.text || title
              }
            }
          } else if (detail.item && detail.item.modules) {
            // 旧的数据结构（兼容）
            console.log('  ✅ 找到opus.detail.item.modules')
            const modules = detail.item.modules
            console.log('  📋 modules键:', Object.keys(modules).join(', '))

            // 提取图片
            if (modules.module_dynamic && modules.module_dynamic.major) {
              console.log('  ✅ 找到module_dynamic.major')
              const major = modules.module_dynamic.major
              console.log('  📋 major键:', Object.keys(major).join(', '))

              if (major.opus && major.opus.pics) {
                console.log('  ✅ 找到major.opus.pics，图片数量:', major.opus.pics.length)
                for (const pic of major.opus.pics) {
                  images.push({
                    url: pic.url,
                    width: pic.width || 0,
                    height: pic.height || 0,
                    size: pic.size || 0
                  })
                }
                title = major.opus.summary || title
              }
            }

            // 提取描述
            if (modules.module_dynamic && modules.module_dynamic.desc) {
              desc = modules.module_dynamic.desc.text || desc
            }

            // 提取作者信息
            if (modules.module_author) {
              author = {
                uid: String(modules.module_author.mid || ''),
                name: modules.module_author.name || '',
                avatar: modules.module_author.face || ''
              }
            }
          } else {
            console.log('  ⚠️ opus.detail中无modules数组')
            // 打印detail的内容
            console.log('  💡 opus.detail内容前1000字符:', JSON.stringify(detail).substring(0, 1000))
          }
        } else {
          console.log('  ⚠️ opus下既无pics也无detail')
          // 打印opus的内容
          console.log('  💡 opus内容前1000字符:', JSON.stringify(state.opus).substring(0, 1000))
        }
      } else if (state.detail) {
        console.log('  ✅ 找到state.detail')
        console.log('  📋 detail键:', Object.keys(state.detail).join(', '))

        // 在detail下
        const detail = state.detail
        if (detail.item && detail.item.modules) {
          console.log('  ✅ 找到detail.item.modules')
          const modules = detail.item.modules
          console.log('  📋 modules键:', Object.keys(modules).join(', '))

          // 提取图片
          if (modules.module_dynamic && modules.module_dynamic.major) {
            console.log('  ✅ 找到module_dynamic.major')
            const major = modules.module_dynamic.major
            console.log('  📋 major键:', Object.keys(major).join(', '))

            if (major.opus && major.opus.pics) {
              console.log('  ✅ 找到major.opus.pics，图片数量:', major.opus.pics.length)
              for (const pic of major.opus.pics) {
                images.push({
                  url: pic.url,
                  width: pic.width || 0,
                  height: pic.height || 0,
                  size: pic.size || 0
                })
              }
              title = major.opus.summary || title
            } else {
              console.log('  ⚠️ major中无opus.pics')
              if (major.opus) {
                console.log('  📋 major.opus键:', Object.keys(major.opus).join(', '))
              }
            }
          } else {
            console.log('  ⚠️ 未找到module_dynamic.major')
          }

          // 提取描述
          if (modules.module_dynamic && modules.module_dynamic.desc) {
            desc = modules.module_dynamic.desc.text || desc
          }

          // 提取作者信息
          if (modules.module_author) {
            author = {
              uid: String(modules.module_author.mid || ''),
              name: modules.module_author.name || '',
              avatar: modules.module_author.face || ''
            }
          }
        } else {
          console.log('  ⚠️ detail中无item.modules')
        }
      } else if (state.dynamicItem) {
        console.log('  ✅ 找到state.dynamicItem')
        console.log('  📋 dynamicItem键:', Object.keys(state.dynamicItem).join(', '))

        // 可能在dynamicItem下
        const item = state.dynamicItem
        if (item.modules) {
          const modules = item.modules
          console.log('  📋 modules键:', Object.keys(modules).join(', '))

          if (modules.module_dynamic && modules.module_dynamic.major) {
            const major = modules.module_dynamic.major
            if (major.opus && major.opus.pics) {
              console.log('  ✅ 在dynamicItem找到图片，数量:', major.opus.pics.length)
              for (const pic of major.opus.pics) {
                images.push({
                  url: pic.url,
                  width: pic.width || 0,
                  height: pic.height || 0,
                  size: pic.size || 0
                })
              }
              title = major.opus.summary || title
            }
          }
        }
      } else {
        console.log('  ⚠️ 未找到预期的数据结构')
        console.log('  💡 尝试打印完整state结构的前2000字符')
        console.log('  ', JSON.stringify(state).substring(0, 2000))
      }

      if (images.length === 0) {
        console.log('  ⚠️ 未提取到图片')
        return null
      }

      console.log('  ✅ 成功提取图片:', images.length, '张')

      return {
        platform: 'bilibili',
        platformName: '哔哩哔哩',
        type: 'image',
        title: title,
        cover: images[0]?.url || '',
        desc: desc,
        author: author,
        images: images,
        statistics: {
          view: '未知',
          like: 0,
          share: 0
        },
        createTime: 0,
        opusId: ''
      }
    } catch (error) {
      console.error('  ❌ 从HTML提取失败:', error.message)
      console.error('  错误堆栈:', error.stack)
      return null
    }
  }

  /**
   * 获取重定向后的URL
   */
  async getFinalUrl(shortUrl) {
    try {
      console.log('  🔗 开始处理短链接重定向...')
      console.log('    短链接:', shortUrl)

      // 方法1: 尝试使用uni.request获取重定向
      const res = await new Promise((resolve, reject) => {
        uni.request({
          url: shortUrl,
          method: 'GET',
          success: (res) => {
            console.log('    请求成功，状态码:', res.statusCode)
            console.log('    响应头:', JSON.stringify(res.header))
            resolve(res)
          },
          fail: (err) => {
            console.log('    请求失败:', err)
            reject(err)
          }
        })
      })

      let finalUrl = shortUrl
      const html = res.data && typeof res.data === 'string' ? res.data : null

      // 检查响应头中的Location
      const location = res.header?.Location || res.header?.location
      if (location) {
        console.log('    ✅ 找到重定向地址(Location):', location)
        finalUrl = location
        return { url: finalUrl, html: html }
      }

      // 方法2: 尝试从响应体中提取
      if (html) {
        // 打印HTML前500字符用于调试
        console.log('    📄 HTML内容预览:', html.substring(0, 500))

        // 查找HTML中的完整bilibili视频URL (多种格式)
        const biliUrlPatterns = [
          /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i,
          /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(av\d+)/i,
          /"url"\s*:\s*"(https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/[^"]+)"/i,
          /location\.href\s*=\s*["'](https?:\/\/[^"']*bilibili\.com\/video\/[^"']+)["']/i,
          /href=["'](https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/[^"']+)["']/i
        ]

        for (const pattern of biliUrlPatterns) {
          const match = html.match(pattern)
          if (match) {
            const extractedUrl = match[1] || match[0]
            console.log('    ✅ 从HTML提取到B站视频URL:', extractedUrl)
            finalUrl = extractedUrl
            return { url: finalUrl, html: html }
          }
        }

        // 查找HTML中的跳转链接 (url=...)
        const urlMatch = html.match(/url=(https?:\/\/[^"'\s&]+)/)
        if (urlMatch) {
          console.log('    ✅ 从响应体提取到URL:', urlMatch[1])
          finalUrl = decodeURIComponent(urlMatch[1])
          return { url: finalUrl, html: html }
        }

        // 查找meta refresh
        const metaMatch = html.match(/<meta[^>]*?content=["'][^"']*?url=(https?:\/\/[^"'\s]+)/i)
        if (metaMatch) {
          console.log('    ✅ 从meta标签提取到URL:', metaMatch[1])
          finalUrl = decodeURIComponent(metaMatch[1])
          return { url: finalUrl, html: html }
        }

        // 查找window.location重定向
        const locationMatch = html.match(/window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i)
        if (locationMatch) {
          console.log('    ✅ 从JavaScript重定向提取到URL:', locationMatch[1])
          finalUrl = locationMatch[1]
          return { url: finalUrl, html: html }
        }

        console.log('    ⚠️ 尝试了所有匹配规则，未找到视频URL')
      }

      console.log('    ⚠️ 未找到重定向地址，返回原URL')
      return { url: finalUrl, html: html }
    } catch (err) {
      console.error('    ❌ 重定向处理失败:', err)
      return { url: shortUrl, html: null }
    }
  }

  /**
   * 从URL中提取视频ID
   */
  extractVideoId(url) {
    console.log('  🔎 正在尝试提取视频ID...')
    console.log('    URL:', url)

    // 如果url为空或undefined，返回null
    if (!url) {
      console.log('    ❌ URL为空')
      return null
    }

    // 匹配BV号
    console.log('    尝试匹配BV号...')
    const bvMatch = url.match(/\/(BV\w+)/)
    if (bvMatch) {
      console.log('    ✅ 匹配到BV号:', bvMatch[1])
      return bvMatch[1]
    }
    console.log('    ❌ 未匹配到BV号')

    // 匹配AV号
    console.log('    尝试匹配AV号...')
    const avMatch = url.match(/\/av(\d+)/)
    if (avMatch) {
      console.log('    ✅ 匹配到AV号:', 'av' + avMatch[1])
      return 'av' + avMatch[1]
    }
    console.log('    ❌ 未匹配到AV号')

    console.error('    ❌ 无法提取视频ID，URL格式不正确')
    return null
  }

  /**
   * 从HTML中提取视频ID
   */
  extractVideoIdFromHtml(html) {
    console.log('  🔎 正在从HTML中提取视频ID...')

    if (!html) {
      console.log('    ❌ HTML为空')
      return null
    }

    // 打印HTML长度
    console.log('    📄 HTML长度:', html.length)

    // 查找包含BV的位置并打印周围内容
    const bvIndex = html.search(/BV[0-9A-Za-z]{10}/i)
    if (bvIndex !== -1) {
      const snippet = html.substring(Math.max(0, bvIndex - 100), Math.min(html.length, bvIndex + 150))
      console.log('    🎯 找到BV号位置，上下文:', snippet.replace(/\s+/g, ' '))
    } else {
      console.log('    ⚠️ 未在HTML中找到BV号模式')
      // 打印HTML的关键部分（前1000字符和包含"video"的部分）
      console.log('    📄 HTML开头:', html.substring(0, 500).replace(/\s+/g, ' '))

      const videoIndex = html.toLowerCase().indexOf('video')
      if (videoIndex !== -1) {
        const snippet = html.substring(videoIndex, Math.min(html.length, videoIndex + 200))
        console.log('    📹 包含video的片段:', snippet.replace(/\s+/g, ' '))
      }
    }

    // 尝试多种匹配模式
    const patterns = [
      // 匹配 BV 号 (各种可能的格式)
      { name: 'BV号-路径', regex: /\/video\/(BV[0-9A-Za-z]{10})/i },
      { name: 'BV号-纯文本', regex: /\b(BV[0-9A-Za-z]{10})\b/i },
      { name: 'BV号-bvid属性', regex: /["']?bvid["']?\s*[:=]\s*["']?(BV[0-9A-Za-z]{10})["']?/i },
      { name: 'BV号-JSON', regex: /"bvid"\s*:\s*"(BV[0-9A-Za-z]{10})"/i },
      { name: 'BV号-URL参数', regex: /[?&]bvid=(BV[0-9A-Za-z]{10})/i },
      { name: 'BV号-data属性', regex: /data-[^=]*=["']*[^"']*\/(BV[0-9A-Za-z]{10})/i },
      { name: 'BV号-href属性', regex: /href=["'][^"']*\/(BV[0-9A-Za-z]{10})/i },

      // 匹配 AV 号
      { name: 'AV号-路径', regex: /\/video\/(av\d+)/i },
      { name: 'AV号-纯文本', regex: /\b(av\d{6,})\b/i },
      { name: 'AV号-aid属性', regex: /"aid"\s*:\s*(\d{6,})/i }
    ]

    for (const { name, regex } of patterns) {
      console.log(`    🔍 尝试模式: ${name}`)
      const match = html.match(regex)
      if (match) {
        const videoId = match[1]
        // 如果是纯数字，添加 av 前缀
        const finalId = /^\d+$/.test(videoId) ? 'av' + videoId : videoId
        console.log(`    ✅ 匹配成功! 视频ID: ${finalId}`)
        return finalId
      }
    }

    console.log('    ❌ 无法从HTML提取视频ID')
    return null
  }

  /**
   * 获取视频详细信息
   */
  async getVideoInfo(videoId) {
    try {
      console.log('  📡 正在请求B站API...')
      console.log('    视频ID:', videoId)

      // B站API
      const apiUrl = `https://api.bilibili.com/x/web-interface/view?${videoId.startsWith('BV') ? 'bvid=' + videoId : 'aid=' + videoId.replace('av', '')}`
      console.log('    API地址:', apiUrl)

      const res = await this.http.get(apiUrl, {}, {
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.bilibili.com/'
        }
      })

      console.log('    响应状态码:', res.statusCode)

      if (res.statusCode !== 200) {
        console.error('    ❌ API请求失败，状态码:', res.statusCode)
        throw new Error('请求失败')
      }

      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
      console.log('    API返回code:', data.code)

      if (data.code !== 0 || !data.data) {
        console.error('    ❌ API返回错误')
        console.error('    code:', data.code)
        console.error('    message:', data.message)
        throw new Error('视频不存在或已被删除')
      }

      const video = data.data
      console.log('    ✅ 获取视频信息成功')
      console.log('    标题:', video.title)
      console.log('    作者:', video.owner?.name)

      // 获取第一个分P的cid（参考PHP版本）
      const cid = video.pages?.[0]?.cid || video.cid || ''
      console.log('    cid:', cid)

      const result = {
        platform: 'bilibili',
        platformName: '哔哩哔哩',
        type: 'video',
        title: video.title || '无标题',
        cover: video.pic || '',
        desc: video.desc || '',
        author: {
          uid: String(video.owner?.mid || ''),
          name: video.owner?.name || '',
          avatar: video.owner?.face || ''
        },
        video: {
          url: '', // B站视频需要额外获取播放链接
          urlNoWatermark: '',
          cid: cid,
          width: video.dimension?.width || 0,
          height: video.dimension?.height || 0,
          duration: video.duration || 0
        },
        statistics: {
          view: video.stat?.view || 0,
          like: video.stat?.like || 0,
          coin: video.stat?.coin || 0,
          favorite: video.stat?.favorite || 0,
          share: video.stat?.share || 0,
          danmaku: video.stat?.danmaku || 0,
          reply: video.stat?.reply || 0
        },
        createTime: video.pubdate || 0,
        videoId: videoId,
        bvid: video.bvid || '',
        aid: video.aid || 0
      }

      // 获取视频下载链接
      if (cid) {
        console.log('  🎥 正在获取播放链接...')
        const playUrl = await this.getPlayUrl(video.bvid || videoId, cid)
        if (playUrl && typeof playUrl === 'object' && playUrl.dash) {
          // DASH 格式：视频流和音频流分离
          result.video.url = playUrl.videoUrl
          result.video.urlNoWatermark = playUrl.videoUrl
          result.video.audioUrl = playUrl.audioUrl
          result.video.isDash = true
          result.video.quality = playUrl.quality
        } else {
          result.video.url = playUrl
          result.video.urlNoWatermark = playUrl
        }
        console.log('    ✅ 获取播放链接成功')
      }

      return result
    } catch (error) {
      console.error('  ❌ 获取B站视频信息失败:', error.message)
      console.error('    视频ID:', videoId)
      console.error('    错误详情:', error)
      throw new Error('解析失败，请稍后重试')
    }
  }

  /**
   * 获取播放链接
   */
  async getPlayUrl(bvid, cid) {
    try {
      // qn=80 表示 1080P，fnval=16 表示请求 DASH 格式（含视频流+音频流）
      const apiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=16`

      const res = await this.http.get(apiUrl, {}, {
        header: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.bilibili.com/'
        }
      })

      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

      if (data.code !== 0 || !data.data) {
        return ''
      }

      // 优先使用 DASH 格式（最高清晰度）：
      // DASH 返回 dash.video（视频流，无声音）和 dash.audio（音频流）
      // 取视频流中 quality 最大的（quality 值越大清晰度越高，80=1080P，112=1080P+，116=1080P60）
      if (data.data.dash && data.data.dash.video && data.data.dash.video.length > 0) {
        // DASH 视频流按 quality 降序排列，取第一个（最高清晰度）
        const sortedVideos = data.data.dash.video.slice().sort((a, b) => b.quality - a.quality)
        // 取最高 quality 的所有流，再选其中 codecid 最高的（AV1 > HEVC > AVC）
        const maxQ = sortedVideos[0].quality
        const topVideos = sortedVideos.filter(v => v.quality === maxQ)
        const codecPriority = { 7: 3, 12: 2, 1: 1 } // AV1=7, HEVC=12, AVC=1
        topVideos.sort((a, b) => (codecPriority[b.codecid] || 0) - (codecPriority[a.codecid] || 0))
        const bestVideo = topVideos[0]
        // 音频流取 bandwidth 最大的
        let audioUrl = ''
        if (data.data.dash.audio && data.data.dash.audio.length > 0) {
          const sortedAudios = data.data.dash.audio.slice().sort((a, b) => b.bandwidth - a.bandwidth)
          audioUrl = sortedAudios[0].baseUrl || sortedAudios[0].base_url || ''
        }
        // B站DASH是分离的，下载器需合并。这里返回视频流URL，音频流通过单独字段返回
        // 但为了兼容现有下载流程（单URL下载），优先返回合并好的 durl 格式
        if (audioUrl) {
          // 返回 DASH 信息供下载器处理
          return {
            dash: true,
            videoUrl: bestVideo.baseUrl || bestVideo.base_url || '',
            audioUrl: audioUrl,
            quality: maxQ,
            acceptQuality: data.data.accept_quality || []
          }
        }
        return bestVideo.baseUrl || bestVideo.base_url || ''
      }

      // 回退：durl 格式（合并好的视频，包含声音）
      if (data.data.durl && data.data.durl[0] && data.data.durl[0].url) {
        return data.data.durl[0].url
      }

      return ''
    } catch (error) {
      console.error('获取播放链接失败:', error)
      return ''
    }
  }
}

module.exports = BilibiliParser
