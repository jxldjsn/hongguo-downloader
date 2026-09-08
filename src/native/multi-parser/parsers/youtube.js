/**
 * yt-dlp 通用解析器
 *
 * 任何非 19 个原生平台支持的链接（Instagram / Twitter / TikTok 国际版 / Reddit 等），
 * 都会回退到这里，交给 yt-dlp（独立 exe，随应用打包）解析元信息和下载。
 *
 * 解析阶段：调用 `yt-dlp -j` 拿到 JSON，提取通用字段（标题/作者/封面/时长/最佳流）。
 *   - 视频：选最佳视频流 + 音频流，下载阶段由 executeYtdlDownload 调用 yt-dlp 合并
 *   - 图集：yt-dlp 返回的 thumbnails / images 列表作为图片下载项
 * 下载阶段：由 main.js 的 executeYtdlDownload 直接调用 yt-dlp 下载并合并（见 download-ytdl）。
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { buildYoutubeCookieArgs, cleanupCookieFile } = require('../../ytCookieFile');

class YtDlpParser {
  constructor() {
    this.ytDlpPath = this.resolveYtDlpPath();
    // 本地代理（Clash 等），境外站点在国内需走代理。读取环境变量，默认 127.0.0.1:7897。
    this.proxy = process.env.YTDL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
  }

  /**
   * 读取应用保存的 YouTube 登录 cookie（DB 的 cookie_youtube）。
   * 用于绕开 YouTube 的 bot 检测（"Sign in to confirm you're not a bot"）。
   * DB 未就绪/读取失败时返回空串（无 cookie 行为与之前一致）。
   */
  readYoutubeCookie() {
    try {
      const db = require('../../database');
      const v = db.getKV ? db.getKV('cookie_youtube', '') : '';
      return String(v || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * 定位 yt-dlp.exe：开发态在项目 assets/，打包后从 app.asar.unpacked 解包出来
   */
  resolveYtDlpPath() {
    try {
      const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const candidates = [
        // 开发态：项目根目录 assets/
        path.join(process.cwd(), 'assets', exeName),
        // 从本文件回溯 4 层到项目根目录的 assets/（开发态=根目录，打包态=resources/app）
        path.join(__dirname, '..', '..', '..', '..', 'assets', exeName),
        // 打包态（asar 开启）：app.asar.unpacked/assets/
        path.join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', exeName),
        // 打包态（本工程 asar 关闭）：resources/app/assets/
        path.join(process.resourcesPath || '', 'app', 'assets', exeName),
      ];
      for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
      }
    } catch (e) {
      console.error('yt-dlp: 定位失败:', e.message);
    }
    return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  }

  /**
   * 判断给定 URL 是否需要走代理
   * 被墙站点（YouTube/Instagram/Twitter/Facebook/Reddit 等）需要代理；
   * TikTok / B站等国内可直连的站点不走代理（强行走代理反而会失败）。
   */
  needsProxy(url) {
    const u = (url || '').toLowerCase();
    // 明确需要代理的站点（国内无法直连）
    const proxySites = [
      'youtube.com', 'youtu.be', 'instagram.com', 'twitter.com', 'x.com',
      'facebook.com', 'fb.watch', 'reddit.com', 'vimeo.com', 'twitch.tv',
      'dailymotion.com', 'pinterest.com', 'streamable.com',
    ];
    for (const s of proxySites) {
      if (u.includes(s)) return true;
    }
    // 其余站点（TikTok / B站等）默认直连
    return false;
  }

  /**
   * 执行 yt-dlp 并返回 stdout（Promise）
   * 智能代理：需要代理的站点走代理，代理失败自动回退直连重试一次
   * YouTube：额外带登录 cookie（--cookies 临时文件），绕开 bot 检测；
   * 登录态可能在运行中变化，每次调用现读 DB。
   */
  runYtDlp(args, url) {
    const useProxy = this.needsProxy(url || '');
    const isYoutube = /youtube\.com|youtu\.be/i.test(url || '');
    const cookieArgs = isYoutube ? buildYoutubeCookieArgs(this.readYoutubeCookie()) : [];
    const buildCmd = (withProxy) => {
      const a = ['--no-warnings', '--no-playlist'];
      if (withProxy) a.push('--proxy', this.proxy);
      if (cookieArgs.length) a.push(...cookieArgs);
      a.push(...args);
      return a;
    };
    const exec = (allArgs) => new Promise((resolve, reject) => {
      console.log('yt-dlp: 启动解析（命令参数已隐藏）', useProxy ? '(代理)' : '(直连)');
      execFile(this.ytDlpPath, allArgs, {
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, YTDL_NO_UPDATE: '1' },
      }, (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || '').trim().slice(0, 500);
          reject(new Error(`yt-dlp 执行失败: ${err.message}${detail ? ' | ' + detail : ''}`));
          return;
        }
        resolve(stdout);
      });
    });
    // 清理临时 cookie 文件（代理重试共用同一文件，等全部结束后再删）
    const cleanup = () => cleanupCookieFile(cookieArgs[1]);

    // 需要代理的站点：先走代理，失败后回退直连重试
    if (useProxy) {
      return exec(buildCmd(true)).catch((e) => {
        console.warn('yt-dlp: 代理失败，回退直连重试:', e.message.slice(0, 120));
        return exec(buildCmd(false));
      }).finally(cleanup);
    }
    // 不需要代理的站点：直接直连
    return exec(buildCmd(false)).finally(cleanup);
  }

  /**
   * 从 URL 中提取 YouTube 视频 ID（仅用于规范化 YouTube 短链）
   * 支持 watch?v= / youtu.be/ / shorts/ / embed/
   * 非 YouTube 链接返回 null（调用方直接用原始 URL 传给 yt-dlp）
   */
  extractVideoId(url) {
    const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (watchMatch) return watchMatch[1];
    const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (shortMatch) return shortMatch[1];
    const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
    const embedMatch = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];
    return null;
  }

  /**
   * 规范化下载入口 URL。YouTube 短链统一成 watch URL，其它链接原样返回。
   * 下载阶段会把此 URL 再次交给 yt-dlp（--proxy），所以规范化有助于稳定解析。
   */
  normalizeDownloadUrl(url) {
    const videoId = this.extractVideoId(url);
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return url;
  }

  /**
   * 通用解析：任意 url -> yt-dlp -j -> 通用结构
   * @param {string} platform  调用方检测到的平台标识（'youtube' 或 'ytdl'）
   * @param {string} platformName  展示用平台名
   */
  async parseWithPlatform(url, platform, platformName) {
    try {
      console.log('yt-dlp: 开始解析 URL:', url, '平台:', platform);

      // YouTube 短链规范化；其它站点直接用原始 URL
      const downloadUrl = this.normalizeDownloadUrl(url);

      // 调用 yt-dlp -j 拿到完整 JSON 信息
      const stdout = await this.runYtDlp(['-j', downloadUrl], downloadUrl);
      let info;
      try {
        info = JSON.parse(stdout);
      } catch (e) {
        throw new Error('解析 yt-dlp 输出失败: ' + e.message);
      }

      const videoDetails = info.videoDetails || {};
      const formats = Array.isArray(info.formats) ? info.formats : [];

      // yt-dlp 用 _type 区分特殊类型：
      //   playlist  -> 播放列表（已 --no-playlist，理论不会出现）
      //   url      -> 跳转链接（少见）
      // 默认按单视频处理

      // 图集检测：yt-dlp 对部分站点的图片/相册返回 thumbnails 列表，
      // 当没有可下载的视频流时，按图集处理。
      const videoOnly = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
      const audioOnly = formats.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
      const combined = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');

      const bestVideo = videoOnly
        .slice()
        .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];
      const bestAudio = audioOnly
        .slice()
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
      const bestCombined = combined
        .slice()
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      // 视频流为空时，尝试按图集处理
      const hasVideoStream = !!(bestVideo || bestCombined);

      // 收集候选图片：优先 images 字段（部分站点），回退 thumbnails
      const imageList = Array.isArray(info.images) ? info.images : [];
      const thumbList = videoDetails.thumbnails || info.thumbnails || [];

      if (!hasVideoStream && (imageList.length > 0 || thumbList.length > 0)) {
        // 图集：构建 images 数组
        const images = [];
        if (imageList.length > 0) {
          for (const img of imageList) {
            const imgUrl = typeof img === 'string' ? img : (img.url || '');
            if (!imgUrl) continue;
            images.push({ url: imgUrl, width: img.width || 0, height: img.height || 0, livePhotoUrl: '' });
          }
        } else {
          // 没有 images 字段，用 thumbnails（取较大尺寸的，避免最小缩略图）
          const sorted = thumbList.slice().sort((a, b) => (b.preference || b.width || 0) - (a.preference || a.width || 0));
          for (const t of sorted) {
            if (!t.url) continue;
            images.push({ url: t.url, width: t.width || 0, height: t.height || 0, livePhotoUrl: '' });
          }
        }

        if (images.length > 0) {
          // 封面取第一张
          const cover = images[0].url;
          const result = {
            platform: platform,
            platformName: platformName,
            type: 'image',
            title: videoDetails.title || info.title || info.fulltitle || '无标题',
            cover: cover,
            desc: videoDetails.shortDescription || info.description || '',
            author: {
              uid: videoDetails.channelId || info.channel_id || info.uploader_id || '',
              name: videoDetails.author || info.uploader || info.channel || '未知',
              avatar: videoDetails.ownerChannelAvatar || ''
            },
            images: images,
          };
          console.log('yt-dlp: 解析成功，图集共', images.length, '张');
          return result;
        }
      }

      // 视频处理
      let quality = '';
      if (bestVideo) {
        quality = bestVideo.height ? `${bestVideo.height}p${bestVideo.fps && bestVideo.fps > 30 ? bestVideo.fps : ''}` : '';
      } else if (bestCombined) {
        quality = bestCombined.height ? `${bestCombined.height}p` : '';
      }

      // 收集可选清晰度列表（供前端弹窗选择）
      // 策略：取所有含视频流的格式，按高度去重，保留每个高度下最佳的（画质/码率最高）
      // 同时保留纯视频流的 format_id，下载阶段用 bestvideo[height<=X]+bestaudio 组合
      const qualityMap = new Map(); // height -> {label, height, fps, ext, formatId, filesize, vcodec, isCombined}
      const candidateFormats = [...videoOnly, ...combined]; // 含视频流的都算
      for (const f of candidateFormats) {
        const h = f.height || 0;
        if (h <= 0) continue;
        const fps = f.fps || 0;
        const tbr = f.tbr || 0;
        const label = `${h}p${fps > 30 ? fps : ''}`;
        const existing = qualityMap.get(h);
        // 同高度优先取码率/帧率高的
        if (!existing || tbr > existing.tbr) {
          qualityMap.set(h, {
            height: h,
            fps: fps,
            tbr: tbr,
            label: label,
            ext: f.ext || 'mp4',
            formatId: String(f.format_id),
            isCombined: !!(f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'),
            // 以下为弹窗展示用字段（不影响下载逻辑）
            filesize: f.filesize || f.filesize_approx || 0,
            vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : '',
          });
        }
      }
      // 按高度降序排列
      const qualities = Array.from(qualityMap.values()).sort((a, b) => b.height - a.height);

      // 封面：取最大缩略图
      let cover = '';
      if (thumbList.length > 0) {
        cover = thumbList[thumbList.length - 1].url || '';
      }

      const result = {
        platform: platform,
        platformName: platformName,
        type: 'video',
        title: videoDetails.title || info.title || info.fulltitle || '无标题',
        cover: cover,
        desc: videoDetails.shortDescription || info.description || '',
        author: {
          uid: videoDetails.channelId || info.channel_id || info.uploader_id || '',
          name: videoDetails.author || info.uploader || info.channel || '未知',
          avatar: videoDetails.ownerChannelAvatar || ''
        },
        video: {
          // 下载入口：交给 yt-dlp 处理（解析签名+合并）
          url: downloadUrl,
          urlNoWatermark: downloadUrl,
          isYtdl: true,            // 标记走 yt-dlp 下载流程
          quality: quality,
          duration: videoDetails.lengthSeconds || info.duration || 0,
          // 可选清晰度列表（前端弹窗选择用，按高度降序）
          qualities: qualities,
          // 解析阶段的格式信息，用于 UI 展示
          bestVideoFormat: bestVideo ? `${bestVideo.format_id} ${bestVideo.ext} ${bestVideo.height || ''}p` : '',
          bestAudioFormat: bestAudio ? `${bestAudio.format_id} ${bestAudio.ext} ${bestAudio.abr || ''}k` : '',
        },
      };

      console.log('yt-dlp: 解析成功，视频', quality ? `(${quality})` : '');
      return result;

    } catch (error) {
      console.error('yt-dlp 解析失败:', error);
      throw error;
    }
  }

  /**
   * 兼容旧接口：index.js 直接调用 parser.parse(url)。
   * 平台标识由 index.js 在解析后覆盖，这里默认使用 'ytdl'。
   */
  async parse(url) {
    return this.parseWithPlatform(url, 'ytdl', 'yt-dlp');
  }
}

module.exports = YtDlpParser
