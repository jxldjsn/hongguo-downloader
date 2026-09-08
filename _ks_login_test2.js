const { app, BrowserWindow, session } = require('electron');
const path = require('path');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:kuaishou');
  for (const url of ['https://id.kuaishou.com/passport/web/login', 'https://id.kuaishou.com/']) {
    const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { partition: 'persist:kuaishou', contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true, preload: path.join(__dirname, 'preload-login.js') }, autoHideMenuBar: true });
    let navError = null;
    win.webContents.on('did-fail-load', (e, code, desc, u) => { navError = `${code}:${desc}`; });
    await win.loadURL(url).catch((e) => { navError = e.message; });
    await new Promise((r) => setTimeout(r, 10000));
    let info = null;
    try {
      info = await win.webContents.executeJavaScript(`(() => ({ title: document.title, len: document.body.innerText.length, text: document.body.innerText.slice(0, 120) }))()`);
    } catch (e) { info = { err: e.message }; }
    let cookies = 0;
    try { cookies = (await ses.cookies.get({ domain: '.kuaishou.com' })).length; } catch (e) {}
    console.log(`\n[${url}]`);
    console.log('  导航错误:', navError || '无');
    console.log('  页面:', JSON.stringify(info));
    console.log('  cookie数:', cookies);
    win.destroy();
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
