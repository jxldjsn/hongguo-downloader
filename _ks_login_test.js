// 验证快手登录：官网加载 + 确认按钮注入 + cookie 提取
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    const ses = session.fromPartition('persist:kuaishou');
    const win = new BrowserWindow({
      width: 1000, height: 700, show: true,
      webPreferences: { partition: 'persist:kuaishou', contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true, preload: path.join(__dirname, 'preload-login.js') },
      autoHideMenuBar: true,
    });
    let loaded = false;
    let navError = null;
    win.webContents.on('did-finish-load', () => { loaded = true; });
    win.webContents.on('did-fail-load', (e, code, desc, url) => { navError = `${code}:${desc} ${url}`; });

    await win.loadURL('https://www.kuaishou.com/').catch((e) => { navError = e.message; });
    await new Promise((r) => setTimeout(r, 12000));

    let info = null;
    try {
      info = await win.webContents.executeJavaScript(`(() => ({
        title: document.title,
        hasLoginText: document.body.innerText.includes('登录') || document.body.innerText.includes('扫码'),
        bodyLen: document.body.innerText.length,
      }))()`);
    } catch (e) { info = { err: e.message }; }

    // 提取 kuaishou.com cookie
    let cookieCount = 0;
    try {
      const cookies = await ses.cookies.get({ domain: '.kuaishou.com' });
      cookieCount = cookies.length;
    } catch (e) {}

    console.log('加载成功:', loaded, '| 导航错误:', navError || '无');
    console.log('页面:', JSON.stringify(info));
    console.log('kuaishou.com 域 cookie 数:', cookieCount);
    win.destroy();
    process.exit(0);
  } catch (e) { console.error('失败:', e.stack || e.message); process.exit(1); }
});
