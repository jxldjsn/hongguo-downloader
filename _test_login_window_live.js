const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profilePath = path.join(os.tmpdir(), `douyin-login-live-test-${process.pid}`);
const resultDir = path.join(__dirname, '_automation_test', 'login-window-live-results');
app.setPath('userData', profilePath);

const targets = {
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/login',
  yuanbao: 'https://yuanbao.tencent.com/chat',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
  kuaishou: 'https://passport.kuaishou.com/',
  bilibili: 'https://passport.bilibili.com/login',
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/signin',
};

const requested = String(process.env.LOGIN_TEST_PLATFORMS || 'xiaohongshu,douyin,kuaishou,bilibili')
  .split(',')
  .map(value => value.trim())
  .filter(value => targets[value]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function screenshotStats(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let sampled = 0;
  let white = 0;
  let transparent = 0;
  const stepX = Math.max(1, Math.floor(size.width / 80));
  const stepY = Math.max(1, Math.floor(size.height / 60));

  for (let y = 0; y < size.height; y += stepY) {
    for (let x = 0; x < size.width; x += stepX) {
      const offset = (y * size.width + x) * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      const alpha = bitmap[offset + 3];
      sampled++;
      if (alpha < 10) transparent++;
      if (red > 245 && green > 245 && blue > 245) white++;
    }
  }

  return {
    width: size.width,
    height: size.height,
    sampled,
    whiteRatio: sampled ? Number((white / sampled).toFixed(4)) : null,
    transparentRatio: sampled ? Number((transparent / sampled).toFixed(4)) : null,
  };
}

async function inspectTarget(platform, url) {
  const partition = `persist:login-live-${platform}-${process.pid}`;
  const ses = session.fromPartition(partition);
  const events = [];
  const consoleErrors = [];
  let rendererGone = null;

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload-login.js'),
    },
  });

  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const record = (name, details = {}) => {
    events.push({ name, atMs: Date.now(), ...details });
  };

  win.webContents.on('did-start-navigation', (_event, nextUrl, _inPlace, isMainFrame) => {
    if (isMainFrame) record('did-start-navigation', { url: nextUrl });
  });
  win.webContents.on('did-redirect-navigation', (_event, nextUrl, _inPlace, isMainFrame) => {
    if (isMainFrame) record('did-redirect-navigation', { url: nextUrl });
  });
  win.webContents.on('did-navigate', (_event, nextUrl, httpResponseCode, httpStatusText) => {
    record('did-navigate', { url: nextUrl, httpResponseCode, httpStatusText });
  });
  win.webContents.on('dom-ready', () => record('dom-ready', { url: win.webContents.getURL() }));
  win.webContents.on('did-finish-load', () => record('did-finish-load', { url: win.webContents.getURL() }));
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) record('did-fail-load', { code, description, url: validatedURL });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    rendererGone = details;
    record('render-process-gone', details);
  });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push({ level, message: String(message).slice(0, 500), line, sourceId });
  });

  const startedAt = Date.now();
  let loadResult;
  try {
    loadResult = await Promise.race([
      win.loadURL(url).then(() => ({ status: 'resolved' })),
      sleep(20000).then(() => ({ status: 'timeout' })),
    ]);
  } catch (error) {
    loadResult = { status: 'rejected', error: error.message };
  }

  await sleep(5000);

  let dom = null;
  let evaluateError = null;
  try {
    dom = await win.webContents.executeJavaScript(`(() => {
      const body = document.body;
      const root = document.querySelector('#app, #root, [id*="app"], main');
      const bodyStyle = body ? getComputedStyle(body) : null;
      const rect = body ? body.getBoundingClientRect() : null;
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        htmlLength: document.documentElement ? document.documentElement.outerHTML.length : -1,
        bodyTextLength: body ? (body.innerText || '').trim().length : -1,
        bodyHtmlLength: body ? body.innerHTML.length : -1,
        bodyChildCount: body ? body.children.length : -1,
        rootHtmlLength: root ? root.innerHTML.length : -1,
        bodyDisplay: bodyStyle ? bodyStyle.display : null,
        bodyVisibility: bodyStyle ? bodyStyle.visibility : null,
        bodyOpacity: bodyStyle ? bodyStyle.opacity : null,
        bodyBackground: bodyStyle ? bodyStyle.backgroundColor : null,
        bodyWidth: rect ? Math.round(rect.width) : -1,
        bodyHeight: rect ? Math.round(rect.height) : -1,
      };
    })()`);
  } catch (error) {
    evaluateError = error.message;
  }

  let screenshot = null;
  let screenshotError = null;
  const screenshotPath = path.join(resultDir, `${platform}.png`);
  try {
    const image = await win.capturePage();
    screenshot = screenshotStats(image);
    fs.writeFileSync(screenshotPath, image.toPNG());
  } catch (error) {
    screenshotError = error.message;
  }

  const result = {
    platform,
    requestedUrl: url,
    finalUrl: win.webContents.getURL(),
    durationMs: Date.now() - startedAt,
    loadResult,
    dom,
    evaluateError,
    rendererGone,
    screenshot,
    screenshotError,
    screenshotPath,
    consoleErrors: consoleErrors.slice(0, 20),
    events,
  };

  win.destroy();
  await ses.clearCache().catch(() => {});
  return result;
}

app.on('window-all-closed', event => event.preventDefault?.());

app.whenReady().then(async () => {
  fs.mkdirSync(resultDir, { recursive: true });
  const results = [];

  for (const platform of requested) {
    console.log(`[LiveLoginTest] START ${platform} ${targets[platform]}`);
    const result = await inspectTarget(platform, targets[platform]);
    results.push(result);
    console.log(`[LiveLoginTest] RESULT ${JSON.stringify({
      platform,
      finalUrl: result.finalUrl,
      loadResult: result.loadResult,
      dom: result.dom,
      rendererGone: result.rendererGone,
      screenshot: result.screenshot,
      consoleErrorCount: result.consoleErrors.length,
    })}`);
  }

  const resultPath = path.join(resultDir, 'results.json');
  fs.writeFileSync(resultPath, JSON.stringify({ profilePath, results }, null, 2));
  console.log(`[LiveLoginTest] WROTE ${resultPath}`);
  app.exit(0);
}).catch(error => {
  console.error('[LiveLoginTest] FATAL', error.stack || error.message);
  app.exit(1);
});
