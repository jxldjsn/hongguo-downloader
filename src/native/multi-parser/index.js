/**
 * 主解析器 - 协调各个平台解析器 (CommonJS 版本，移植自 uni-app)
 */
const HttpClient = require('./http')
const { UrlExtractor } = require('./http')

const DouyinParser = require('./parsers/douyin')
const KuaishouParser = require('./parsers/kuaishou')
const XiaohongshuParser = require('./parsers/xiaohongshu')
const BilibiliParser = require('./parsers/bilibili')
const WeiboParser = require('./parsers/weibo')
const PipixiaParser = require('./parsers/pipixia')
const XiguaParser = require('./parsers/xigua')
const HuoshanParser = require('./parsers/huoshan')
const HuyaParser = require('./parsers/huya')
const AcfunParser = require('./parsers/acfun')
const LishipinParser = require('./parsers/lishipin')
const MeipaiParser = require('./parsers/meipai')
const QuanminkgeParser = require('./parsers/quanminkge')
const SixroomParser = require('./parsers/sixroom')
const WeishiParser = require('./parsers/weishi')
const ZuiyouParser = require('./parsers/zuiyou')
const QuanminParser = require('./parsers/quanmin')
const HaokanParser = require('./parsers/haokan')
const YoutubeParser = require('./parsers/youtube')
const TiktokParser = require('./parsers/tiktok')

class VideoParser {
  constructor() {
    // 注册所有解析器
    this.parsers = {
      'douyin': new DouyinParser(),
      'kuaishou': new KuaishouParser(),
      'xiaohongshu': new XiaohongshuParser(),
      'bilibili': new BilibiliParser(),
      'weibo': new WeiboParser(),
      'pipixia': new PipixiaParser(),
      'xigua': new XiguaParser(),
      'huoshan': new HuoshanParser(),
      'huya': new HuyaParser(),
      'acfun': new AcfunParser(),
      'lishipin': new LishipinParser(),
      'meipai': new MeipaiParser(),
      'quanminkge': new QuanminkgeParser(),
      'sixroom': new SixroomParser(),
      'weishi': new WeishiParser(),
      'zuiyou': new ZuiyouParser(),
      'quanmin': new QuanminParser(),
      'haokan': new HaokanParser(),
      // youtube.js 现已改造为通用 yt-dlp 解析器：YouTube 走 youtube，
      // 其它任何未识别平台走 ytdl 回退。两者复用同一个解析器实例。
      'youtube': new YoutubeParser(),
      'ytdl': new YoutubeParser(),
      'tiktok': new TiktokParser()
    }

    // 平台信息
    this.platforms = {
      'douyin': { name: '抖音', features: ['视频', '图集', 'LivePhoto', '去水印'] },
      'kuaishou': { name: '快手', features: ['视频', '图集'] },
      'xiaohongshu': { name: '小红书', features: ['视频', '图集', 'LivePhoto'] },
      'bilibili': { name: '哔哩哔哩', features: ['视频'] },
      'weibo': { name: '微博', features: ['视频', '图集'] },
      'pipixia': { name: '皮皮虾', features: ['视频', '图集'] },
      'xigua': { name: '西瓜视频', features: ['视频'] },
      'weishi': { name: '微视', features: ['视频'] },
      'zuiyou': { name: '最右', features: ['视频'] },
      'huoshan': { name: '火山', features: ['视频'] },
      'quanmin': { name: '度小视', features: ['视频'] },
      'lishipin': { name: '梨视频', features: ['视频'] },
      'huya': { name: '虎牙', features: ['视频'] },
      'acfun': { name: 'A站', features: ['视频'] },
      'meipai': { name: '美拍', features: ['视频'] },
      'quanminkge': { name: '全民K歌', features: ['音频', '视频'] },
      'sixroom': { name: '六间房', features: ['视频'] },
      'haokan': { name: '好看视频', features: ['视频'] },
      'youtube': { name: 'YouTube', features: ['视频'] },
      'tiktok': { name: 'TikTok', features: ['视频'] },
      // ytdl 是兜底平台：任意不在 19 个原生平台列表中的链接都走这里
      // 支持站点参考 yt-dlp（Instagram / Twitter / TikTok 国际版 / Reddit 等 1000+ 站点）
      'ytdl': { name: 'yt-dlp 通用', features: ['视频', '图集'] }
    }
  }

  /**
   * 解析分享文本或链接
   * @param {string} text 用户输入的分享文本或链接
   * @returns {Promise<{success:boolean, data?:object, error?:string, platform?:string}>}
   */
  async parse(text) {
    try {
      // 1. 提取URL
      let url = UrlExtractor.extractUrl(text)
      if (!url) {
        throw new Error('未检测到有效链接')
      }

      // 2. 识别平台
      let platform = UrlExtractor.detectPlatform(url)
      let platformName

      if (!platform) {
        // 未匹配到 19 个原生平台 -> 回退到 yt-dlp 通用解析
        // yt-dlp 支持 1000+ 站点（Instagram / Twitter / TikTok 国际版 / Reddit 等）
        platform = 'ytdl'
        platformName = this.platforms['ytdl'].name
        console.log('未识别平台，回退到 yt-dlp 通用解析:', url)
      } else {
        platformName = this.platforms[platform]?.name || platform
      }

      // 3. 获取对应的解析器
      const parser = this.parsers[platform]
      if (!parser) {
        throw new Error(`${platformName}解析器暂未实现`)
      }

      // 4. 执行解析
      // YouTube 与 ytdl 共用同一个通用解析器实例，通过平台标识区分展示
      let result
      if (platform === 'youtube' || platform === 'ytdl') {
        result = await parser.parseWithPlatform(url, platform, platformName)
      } else {
        result = await parser.parse(url)
      }

      // 5. 添加平台信息
      result.platform = platform
      result.platformName = platformName

      return {
        success: true,
        data: result,
        platform: platform,
        platformName: platformName
      }
    } catch (error) {
      return {
        success: false,
        error: error.message || '解析失败'
      }
    }
  }

  /**
   * 获取支持的平台列表
   */
  getSupportedPlatforms() {
    return Object.keys(this.platforms).map(key => ({
      code: key,
      name: this.platforms[key].name,
      features: this.platforms[key].features,
      implemented: !!this.parsers[key]
    }))
  }

  /**
   * 检查平台是否支持
   */
  isPlatformSupported(platform) {
    return !!this.parsers[platform]
  }
}

// 创建单例
const parser = new VideoParser()

module.exports = parser
module.exports.VideoParser = VideoParser
module.exports.default = parser
