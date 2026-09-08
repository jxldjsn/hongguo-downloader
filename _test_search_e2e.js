// 临时端到端测试 v4：显示窗口 + 抓真实 feed 请求参数
const { app, session, BrowserWindow } = require('electron');
const { DouyinAPI } = require('./src/native/apiService');

app.whenReady().then(async () => {
  try {
    // 1. 直接测 fetchWebId 是否成功
    const api = new DouyinAPI('', null, { timeout: 15000, maxRetry: 1 });
    const wid = await api.fetchWebId();
    console.log('[1] fetchWebId 结果:', wid ? wid.slice(0, 25) + '... (真实)' : 'null (失败)');

    // 2. 显示窗口加载首页，滚动抓请求
    const win = new BrowserWindow({
      show: true, width: 900, height: 700,
      webPreferences: { partition: 'persist:douyin', nodeIntegration: false, contextIsolation: true },
    });
    win.webContents.setBackgroundThrottling(false);
    await win.loadURL('https://www.douyin.com/');
    await new Promise((r) => setTimeout(r, 6000));
    await win.webContents.executeJavaScript(`
      window.__qbReqs=[];
      const log=(u)=>{try{if(/aweme\\/v1\\/web/.test(u))window.__qbReqs.push(u);}catch(e){}};
      const of=window.fetch; if(of)window.fetch=function(){try{log(typeof arguments[0]==='string'?arguments[0]:(arguments[0]&&arguments[0].url));}catch(e){} return of.apply(this,arguments);};
      window.scrollTo(0,3000); setTimeout(()=>window.scrollTo(0,6000),1500);
    `).catch(() => {});
    await new Promise((r) => setTimeout(r, 9000));
    const reqs = await win.webContents.executeJavaScript('window.__qbReqs||[]');
    console.log('[2] 捕获 web API 请求:', reqs.length, '条');
    const feed = reqs.find((u) => /feed/.test(u)) || reqs[0] || '';
    console.log('[3] feed 请求参数(前700):', decodeURIComponent(feed).slice(0, 700));
    const ms = (feed.match(/msToken=([^&]+)/) || [])[1];
    console.log('[4] msToken:', ms ? decodeURIComponent(ms).slice(0, 25) + '...' : '无');
    console.log('[5] webid 参数:', (feed.match(/webid=([^&]+)/) || [])[1] || '无');
  } catch (e) {
    console.error('失败:', e.stack || e.message);
  }
  app.exit(0);
});
