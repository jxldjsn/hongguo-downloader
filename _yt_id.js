// 验证 extractShorts 的 video_id 与标题是否错位
const https = require('https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('超时')));
  });
}
(async () => {
  const body = await get('https://www.youtube.com/@iamfromkorea/shorts');
  let dm = body.match(/var ytInitialData = (\{.*?\});<\/script>/);
  if (!dm) dm = body.match(/window\["ytInitialData"\] = (\{.*?\});/);
  const data = JSON.parse(dm[1]);
  // 递归提取所有 shortsLockupViewModel 的 title + entityId + onTap videoId
  function walk(obj, out) {
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, out)); return; }
    if (!obj || typeof obj !== 'object') return;
    if (obj.shortsLockupViewModel) {
      const vm = obj.shortsLockupViewModel;
      const title = vm.overlayMetadata?.primaryText?.content || '';
      const entityId = String(vm.entityId || '');
      // 现有提取逻辑：优先 onTap.videoId
      let vidFromOnTap = '';
      const ep = vm.onTap?.innertubeCommand?.reelWatchEndpoint;
      if (ep?.videoId) vidFromOnTap = ep.videoId;
      // entityId 提取
      const m = entityId.match(/shortVideoId-([A-Za-z0-9_-]{11})|shorts-shelf-item-([A-Za-z0-9_-]{11})/);
      const vidFromEntity = m ? (m[1] || m[2]) : '';
      out.push({ title: title.slice(0, 30), entityId: entityId.slice(0, 45), vidOnTap: vidFromOnTap, vidEntity: vidFromEntity });
    }
    for (const k of Object.keys(obj)) walk(obj[k], out);
  }
  const items = [];
  walk(data, items);
  console.log('共', items.length, '条:');
  items.slice(0, 8).forEach((it, i) => {
    console.log(`[${i}] title=${JSON.stringify(it.title)} | onTap=${it.vidOnTap} | entity=${it.vidEntity} | 一致=${it.vidOnTap === it.vidEntity ? '✓' : '✗ 不一致!'}`);
  });
  // 检查用户下载的那个视频 ID
  console.log('\n用户下载 YLdZ-hK_lW8 是否存在且对应哪个标题:');
  items.forEach((it, i) => {
    if (it.vidOnTap === 'YLdZ-hK_lW8' || it.vidEntity === 'YLdZ-hK_lW8') {
      console.log(`  找到: [${i}] title=${JSON.stringify(it.title)}`);
    }
  });
})();
