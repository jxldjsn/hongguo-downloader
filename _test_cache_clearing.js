const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log('=== Diagnostic: Cache & Hardware Acceleration ===');

  const platform = 'xiaohongshu';
  const sessionName = `persist:${platform}`;
  const ses = session.fromPartition(sessionName);

  try {
    console.log('1. Clearing Cache & Storage Data...');
    await ses.clearCache();
    await ses.clearStorageData({
      storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
    });
    console.log('Cache & Storage Data cleared successfully.');
  } catch (e) {
    console.error('Error clearing storage:', e.message);
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: true,
    title: '小红书缓存深度测试',
    webPreferences: {
      partition: sessionName,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload-login.js')
    }
  });

  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.log('did-fail-load:', code, desc, url);
  });

  win.webContents.on('render-process-gone', (e, details) => {
    console.log('render-process-gone:', details);
  });

  console.log('2. Loading https://www.xiaohongshu.com/ ...');
  await win.loadURL('https://www.xiaohongshu.com/').catch(e => console.log('loadURL error:', e.message));

  console.log('Waiting 6 seconds...');
  await new Promise(r => setTimeout(r, 6000));

  const info = await win.webContents.executeJavaScript(`(() => ({
    url: location.href,
    title: document.title,
    bodyLen: document.body ? document.body.innerText.length : -1,
    htmlLen: document.documentElement ? document.documentElement.outerHTML.length : -1,
    appDivLen: document.getElementById('app') ? document.getElementById('app').innerHTML.length : -1
  }))()`);

  console.log('Page Info:', JSON.stringify(info, null, 2));

  win.destroy();
  process.exit(0);
});
