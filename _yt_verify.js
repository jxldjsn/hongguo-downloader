// 验证：Node 直连 YouTube 频道 Shorts 页 + ytInitialData 解析 + continuation 翻页
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function extractShorts(obj, out) {
  if (Array.isArray(obj)) { obj.forEach((i) => extractShorts(i, out)); return; }
  if (!obj || typeof obj !== 'object') return;
  if (obj.shortsLockupViewModel) {
    const vm = obj.shortsLockupViewModel;
    const title = (vm.overlayMetadata && vm.overlayMetadata.primaryText && vm.overlayMetadata.primaryText.content) || '';
    const views = (vm.overlayMetadata && vm.overlayMetadata.secondaryText && vm.overlayMetadata.secondaryText.content) || '';
    let videoId = '';
    const ep = vm.onTap && vm.onTap.innertubeCommand && vm.onTap.innertubeCommand.reelWatchEndpoint;
    if (ep && ep.videoId) videoId = ep.videoId;
    if (!videoId) {
      const m = String(vm.entityId || '').match(/shortVideoId-([A-Za-z0-9_-]{11})|shorts-shelf-item-([A-Za-z0-9_-]{11})/);
      if (m) videoId = m[1] || m[2];
    }
    if (videoId) out.push({ video_id: videoId, title, views });
  }
  for (const k of Object.keys(obj)) extractShorts(obj[k], out);
}

function findToken(obj) {
  if (Array.isArray(obj)) { for (const i of obj) { const r = findToken(i); if (r) return r; } return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.continuationItemRenderer && obj.continuationItemRenderer.continuationEndpoint && obj.continuationItemRenderer.continuationEndpoint.continuationCommand && obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token) {
    return obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }
  for (const k of Object.keys(obj)) { const r = findToken(obj[k]); if (r) return r; }
  return null;
}

(async () => {
  try {
    const url = 'https://www.youtube.com/@iamfromkorea/shorts';
    console.log('[1] 请求页面:', url);
    const r = await get(url);
    console.log('[1] HTTP', r.status, 'HTML长度', r.body.length);
    if (r.status !== 200) { console.log('失败', r.body.slice(0, 300)); process.exit(1); }

    // 提取 ytcfg
    const cfgMatch = r.body.match(/ytcfg\.set\(\s*(\{.*?\})\s*\)\s*;/);
    let cfg = {};
    if (cfgMatch) {
      try { cfg = JSON.parse(cfgMatch[1]); } catch (e) { console.log('ytcfg 解析失败:', e.message); }
    }
    const apiKey = cfg.INNERTUBE_API_KEY || '';
    const clientCtx = (cfg.INNERTUBE_CONTEXT && cfg.INNERTUBE_CONTEXT.client) || {};
    const clientVer = cfg.INNERTUBE_CONTEXT_CLIENT_VERSION || clientCtx.clientVersion || '';
    const clientName = cfg.INNERTUBE_CONTEXT_CLIENT_NAME || 1;
    console.log('[2] api_key:', apiKey ? apiKey.slice(0, 10) + '...' : '无', '| clientVer:', clientVer, '| clientName:', clientName);

    // 提取 ytInitialData
    let dataMatch = r.body.match(/var ytInitialData = (\{.*?\});<\/script>/);
    if (!dataMatch) dataMatch = r.body.match(/window\["ytInitialData"\] = (\{.*?\});/);
    if (!dataMatch) { console.log('[2] 未找到 ytInitialData'); process.exit(1); }
    let initial;
    try { initial = JSON.parse(dataMatch[1]); } catch (e) { console.log('[2] ytInitialData 解析失败:', e.message, '| 片段:', dataMatch[1].slice(0, 100)); process.exit(1); }

    const all = [];
    const seen = new Set();
    const page1 = [];
    extractShorts(initial, page1);
    for (const s of page1) { if (!seen.has(s.video_id)) { seen.add(s.video_id); all.push(s); } }
    console.log('[3] 首屏 Shorts:', all.length, '条');
    console.log('    样例:', JSON.stringify(all[0]));

    // continuation 翻页
    let token = findToken(initial);
    let page = 1;
    while (token && page < 5) {
      page++;
      const browseUrl = 'https://www.youtube.com/youtubei/v1/browse?key=' + encodeURIComponent(apiKey);
      const payload = { context: { client: clientCtx }, continuation: token };
      const pr = await post(browseUrl, payload, {
        'X-YouTube-Client-Name': String(clientName),
        'X-YouTube-Client-Version': clientVer,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      });
      if (pr.status !== 200) { console.log('[4] 第' + page + '页 HTTP', pr.status); break; }
      let cd;
      try { cd = JSON.parse(pr.body); } catch (e) { console.log('[4] 第' + page + '页 JSON 解析失败'); break; }
      const fresh = [];
      extractShorts(cd, fresh);
      let added = 0;
      for (const s of fresh) { if (!seen.has(s.video_id)) { seen.add(s.video_id); all.push(s); added++; } }
      console.log('[4] 第' + page + '页新增', added, '条，累计', all.length);
      token = findToken(cd);
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('[5] 总计:', all.length, '条 Shorts');
    console.log('    前3条标题:', all.slice(0, 3).map((s) => s.title.slice(0, 30)).join(' | '));
    process.exit(0);
  } catch (e) {
    console.error('异常:', e.message);
    process.exit(1);
  }
})();
