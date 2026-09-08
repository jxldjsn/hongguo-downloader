/**
 * 抖音作品类型判断与下载项构造工具
 *
 * 关键背景：抖音"图文作品"（aweme_type=2，即图集+背景音乐）的
 * item.video.play_addr 看似是视频地址，实际指向的是 ies-music 目录下的
 * mp3 背景音乐。只有 item.video.bit_rate 有内容、duration>0 才是真视频流。
 *
 * 因此判断"是否有真视频"不能只看 play_addr 是否存在，否则图文作品会被
 * 误判成视频，导致只下载到音乐文件。
 */

/**
 * 判断 item 是否有真正的视频流（而非图文作品的 BGM）
 * @param {object} item 抖音 aweme 对象
 * @returns {boolean}
 */
export function hasRealVideoStream(item) {
  const v = item && item.video
  if (!v) return false
  // 1. 真视频会有码率档位
  if (Array.isArray(v.bit_rate) && v.bit_rate.length > 0) return true
  // 2. 真视频有时长
  if (v.duration && Number(v.duration) > 0) return true
  // 3. play_addr.uri 不能指向 ies-music（图文 BGM）
  const uri = v.play_addr && v.play_addr.uri
  if (uri && typeof uri === 'string' && uri.includes('ies-music')) return false
  // 4. download_addr 存在则视为真视频
  if (v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0]) return true
  // 5. play_addr.url_list 存在且不含 .mp3 才视为真视频
  const playUrl = v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0]
  if (playUrl && !playUrl.includes('.mp3')) return true
  return false
}

/**
 * 判断是否为图文作品（图集）
 *
 * 关键：抖音图集作品必然带非空的 images 数组（aweme_type=2/68），普通视频不带 images。
 * 不能再用 hasRealVideoStream 做兜底判断——图集作品的 video.play_addr.uri
 * 可能是封面/引导视频地址（非 ies-music、不含 .mp3、duration=0、无 bit_rate），
 * 会被 hasRealVideoStream 误判成"真视频"，导致图集被当普通视频下载、图片丢失。
 * @param {object} item 抖音 aweme 对象
 * @returns {boolean}
 */
export function isImageWork(item) {
  return !!(item && item.images && item.images.length > 0)
}

/**
 * 把像素高度转成人类可读的清晰度标签
 * 2160 -> 4K, 1440 -> 2K, 1080 -> 1080p, 720 -> 720p ...
 * @param {number} height
 * @returns {string}
 */
function heightToLabel(height) {
  if (!height || height <= 0) return '';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  return `${height}p`;
}

function bitRateHeight(candidate) {
  return Number(candidate?.play_addr?.height || candidate?.height || 0);
}

function bitRateValue(candidate) {
  return Number(candidate?.bit_rate || candidate?.bitrate || candidate?.play_addr?.data_size || 0);
}

function sortBitRateCandidates(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) =>
    bitRateHeight(b) - bitRateHeight(a) || bitRateValue(b) - bitRateValue(a));
}

/**
 * 从抖音 aweme 的 video.bit_rate 数组提取可选清晰度列表
 *
 * 抖音 bit_rate 数组每个元素含 gear_name（如 "adapt_lowest_1080_1"、"normal_720_0"）
 * 和 play_addr.height（像素高度，如 1080、720、540）。
 * gear_name 是 API 内部编码，不直观；这里统一用 height 生成干净标签
 * （4K / 2K / 1080p / 720p / 540p），按分辨率去重（同分辨率只保留码率最高的），
 * 按高度从高到低排序。
 *
 * @param {object} item 抖音 aweme 对象
 * @returns {Array<{label:string, value:string, url:string}>} 清晰度选项数组
 *   首项固定为 {label:'默认（最高）', value:'auto', url:''}（url 用默认逻辑取）
 */
export function extractQualityOptions(item) {
  const options = [{ label: '默认（最高）', value: 'auto', url: '' }];
  const v = item && item.video;
  const bitRate = v && Array.isArray(v.bit_rate) ? v.bit_rate : [];
  const sortedBitRates = sortBitRateCandidates(bitRate);
  // key=height, value={label,url,height}; 同分辨率保留按码率排序后的第一项
  const byHeight = new Map();
  sortedBitRates.forEach((br) => {
    const playAddr = br && br.play_addr;
    const url = playAddr && playAddr.url_list && playAddr.url_list[0];
    if (!url) return;
    const height = Number(playAddr.height || br.height || 0);
    // 过滤掉不可用的极低分辨率档位（抖音 adapt_lowest_4_1 等占位/音频流，低于 360p 不算正常视频流）
    if (height < 360) return;
    const label = heightToLabel(height);
    if (!byHeight.has(height)) {
      byHeight.set(height, { label, value: String(height), url, height });
    }
  });
  // 按高度从高到低排序
  const sorted = [...byHeight.values()].sort((a, b) => b.height - a.height);
  sorted.forEach((q) => {
    options.push({ label: q.label, value: q.value, url: q.url });
  });
  return options;
}

/**
 * 按指定清晰度取视频直链 URL
 * - 'auto' 或空：按高度、码率选最佳 bit_rate，再降级到 download_addr/play_addr
 * - 指定档位：value 是像素高度（如 "1080"），在 bit_rate 里找 height 匹配的；
 *   找不到则降级用默认逻辑，保证不中断下载
 *
 * @param {object} item 抖音 aweme 对象
 * @param {string} qualityLabel 清晰度标签（'auto' 或 '1080' 等像素高度字符串）
 * @returns {string} 视频 URL
 */
export function pickQualityUrl(item, qualityLabel = 'auto') {
  const v = item && item.video;
  const bitRate = v && Array.isArray(v.bit_rate) ? v.bit_rate : [];
  const sortedBitRates = sortBitRateCandidates(bitRate);
  const bestCandidateUrl = sortedBitRates
    .map(candidate => candidate?.play_addr?.url_list?.[0])
    .find(Boolean) || '';
  const defaultUrl =
    bestCandidateUrl ||
    (v && v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0]) ||
    (v && v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0]) ||
    '';

  if (!qualityLabel || qualityLabel === 'auto') return defaultUrl;

  // 在 bit_rate 里找匹配高度的档位（优先码率最高，即第一个匹配项）
  const targetHeight = Number(qualityLabel);
  for (const br of sortedBitRates) {
    const playAddr = br && br.play_addr;
    const url = playAddr && playAddr.url_list && playAddr.url_list[0];
    if (!url) continue;
    const height = Number(playAddr.height || br.height || 0);
    if (height === targetHeight) return url;
  }
  // 找不到指定档位 -> 降级用默认
  return defaultUrl;
}

/**
 * 从 url_list 中挑选最优图片地址：优先 jpg/png 原图，跳过 webp 占位
 * @param {string[]} urlList
 * @returns {string}
 */
function pickImageUrl(urlList) {
  if (!urlList || urlList.length === 0) return ''
  return urlList.find(u => /\.(jpe?g|png)(\?|$)/i.test(u))
      || urlList.find(u => u && !/\.webp/i.test(u))
      || urlList[0]
      || ''
}

/**
 * 为图文作品构造图集下载项（图片 + BGM 音乐 + LivePhoto 动态照片）
 * 下载后会打包到同一个文件夹。
 *
 * @param {object} item 抖音 aweme 对象
 * @returns {Array<{url:string, type:string, ext:string}>} 下载项数组
 */
export function buildImageWorkItems(item) {
  const items = []
  const imageList = item && item.images ? item.images : []

  // 1. 图片：每张取最优 url
  imageList.forEach(img => {
    const url = pickImageUrl(img.url_list || [])
    if (url) items.push({ url, type: 'image', ext: '.jpg' })
    // 2. LivePhoto 动态照片（图集中的 mp4）
    const liveUrl = img.video && img.video.play_addr && img.video.play_addr.url_list && img.video.play_addr.url_list[0]
    if (liveUrl) items.push({ url: liveUrl, type: 'video', ext: '.mp4' })
  })

  // 3. 背景音乐（图文作品的 video.play_addr 实为 BGM）
  const v = item && item.video
  const bgmUri = v && v.play_addr && v.play_addr.uri
  if (bgmUri && typeof bgmUri === 'string' && bgmUri.includes('ies-music')) {
    // uri 直接是 mp3 直链，比 play_addr.url_list 的中转地址更稳定
    items.push({ url: bgmUri, type: 'audio', ext: '.mp3' })
  } else {
    // 兜底：从 music 字段取
    const musicUrl = item && item.music && item.music.play_url && item.music.play_url.url_list && item.music.play_url.url_list[0]
    if (musicUrl) items.push({ url: musicUrl, type: 'audio', ext: '.mp3' })
  }

  return items.filter(it => it.url)
}
