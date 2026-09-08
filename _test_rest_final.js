// 决定性验证：cookie 写入 session store + CDP 拦截 REST 响应
const { app, BrowserWindow, session } = require('electron');
const Store = require('electron-store');
const st = new Store({ name: 'config', cwd: 'C:/Users/c1732/AppData/Roaming/douyin-downloader' });
const cookie = st.get('cookie_kuaishou', '');
const log = (m) => console.log('[REST] ' + m);

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:ks-rest');
  // 写入 session store
  for (const p of cookie.split(';')) {
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    try {
      await ses.cookies.set({
        url: 'https://www.kuaishou.com',
        name: p.slice(0, idx).trim(),
        value: p.slice(idx + 1).trim(),
        path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction',
        expirationDate: Math.floor(Date.now()/1000) + 86400 * 30,
      });
    } catch (e) {}
  }
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses, backgroundThrottling: false } });
  await win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

  // CDP 拦截
  const dbg = win.webContents.debugger;
  const feedIds = {};
  dbg.attach('1.3');
  await dbg.sendCommand('Network.enable').catch(()=>{});
  dbg.on('message', async (e, method, params) => {
    if (method === 'Network.responseReceived' && params.response.url.includes('/rest/v/profile/feed')) {
      feedIds[params.requestId] = params.response.url;
      log('feed 请求: STATUS=' + params.response.status + ' ' + params.response.url.slice(0, 60));
    } else if (method === 'Network.loadingFinished' && feedIds[params.requestId]) {
      try {
        const res = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const d = JSON.parse(res.body || '{}');
        log('feed 响应: result=' + d.result + ' feeds=' + (d.feeds ? d.feeds.length : 0));
        if (d.result === 1 && d.feeds && d.feeds[0]) {
          log('  首个作品: ' + JSON.stringify(d.feeds[0]).slice(0, 350));
        }
        if (d.result === 109) log('  需登录: ' + (d.loginUrl || '').slice(0, 80));
      } catch (err) { log('  解析失败: ' + err.message); }
    }
  });

  log('加载主页...');
  await Promise.race([win.loadURL('https://www.kuaishou.com/profile/3x9bby984bftshc').catch((e)=>{log('  err: '+e.message)}), new Promise(r=>setTimeout(r,20000))]);
  await new Promise(r=>setTimeout(r,8000));
  // 滚动触发
  for (let i = 0; i < 5; i++) {
    await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(()=>{});
    await new Promise(r=>setTimeout(r,2500));
  }
  const dom = await win.webContents.executeJavaScript(`({
    loggedIn: !document.body.innerText.includes('立即登录'),
    cards: document.querySelectorAll('.cards > *').length,
  })`);
  log('最终 DOM: ' + JSON.stringify(dom));
  log('DONE');
  try { if (dbg.isAttached()) dbg.detach(); } catch(e){}
  app.exit(0);
});
