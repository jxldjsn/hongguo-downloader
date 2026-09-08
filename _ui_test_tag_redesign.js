/* 验证新版标签 UI：主题配色 / 弹窗结构 / 交互（勾选、预览移除、新建、保存） / 无溢出 */
const http = require('http');
const WebSocket = require('ws');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
async function connect() {
  const pages = await getJson('http://127.0.0.1:9222/json');
  const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', buf => {
    const msg = JSON.parse(buf.toString());
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  });
  return { ws, eval: (expr) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); }) };
}

(async () => {
  const cdp = await connect();
  const E = cdp.eval;
  const out = [];

  // 等待就绪 → 运营 tab → 账号管理
  for (let i = 0; i < 30; i++) { const r = await E(`!!document.querySelector('.sidebar-tab-ops')`); if (r.result.value) break; await sleep(500); }
  await E(`document.querySelector('.sidebar-tab-ops')?.click(); true`); await sleep(800);
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.querySelector('.nav-label')?.textContent.trim() === '账号管理'); if (b) b.click(); return !!b; })()`); await sleep(1200);

  // 打开第一个账号的标签编辑弹窗
  const opened = await E(`(() => {
    const cards = [...document.querySelectorAll('.account-card')];
    if (!cards.length) return { ok: false, err: '无账号卡片' };
    const btn = [...cards[0].querySelectorAll('button')].find(b => b.textContent.includes('标签'));
    if (!btn) return { ok: false, err: '无标签按钮' };
    btn.click();
    return { ok: true };
  })()`);
  out.push(['打开标签弹窗', opened.result.value]);
  await sleep(600);

  // 弹窗结构 + 配色探测（默认浅色主题）
  const probe = await E(`(() => {
    const m = document.querySelector('.tag-edit-modal');
    if (!m) return { err: '弹窗未渲染' };
    const cs = (el) => getComputedStyle(el);
    const grid = document.querySelector('.preset-tags-grid');
    const chips = [...document.querySelectorAll('.tag-toggle-chip')];
    const firstChip = chips[0];
    return {
      modalBg: cs(m).backgroundColor,
      modalBorderRadius: cs(m).borderRadius,
      modalWidth: Math.round(m.getBoundingClientRect().width),
      overflowX: m.scrollWidth > m.clientWidth,
      hasIcon: !!document.querySelector('.tag-edit-icon'),
      titleMain: document.querySelector('.tag-edit-title-main')?.textContent,
      subtitle: document.querySelector('.tag-edit-subtitle')?.textContent,
      sectionLabels: [...document.querySelectorAll('.tag-section-label')].map(x => x.textContent),
      chipCount: chips.length,
      chipBg: cs(firstChip).backgroundColor,
      chipRadius: cs(firstChip).borderRadius,
      gridBg: cs(grid).backgroundColor,
      tipBg: cs(document.querySelector('.tag-edit-tip')).backgroundColor,
      inputPlaceholder: document.querySelector('.tag-edit-input')?.placeholder,
      footerButtons: [...document.querySelectorAll('.tag-edit-footer button')].map(b => b.textContent.trim()),
      emptyBox: !!document.querySelector('.selected-tags-empty'),
    };
  })()`);
  out.push(['弹窗结构/配色', probe.result.value]);
  const probeVal = probe.result.value;

  // 勾选一个标签
  const sel = await E(`(() => {
    const chip = [...document.querySelectorAll('.tag-toggle-chip')].find(c => !c.classList.contains('selected'));
    if (!chip) return { err: '无可勾选标签' };
    chip.click();
    return { name: chip.querySelector('.tag-toggle-name').textContent };
  })()`);
  out.push(['勾选标签', sel.result.value]);
  await sleep(400);
  const selState = await E(`(() => {
    const sel = document.querySelector('.tag-toggle-chip.selected');
    if (!sel) return { err: '无选中态' };
    const cs = getComputedStyle(sel);
    return {
      name: sel.querySelector('.tag-toggle-name').textContent,
      bg: cs.backgroundColor,
      color: cs.color,
      fontWeight: cs.fontWeight,
      checkText: sel.querySelector('.tag-toggle-check').textContent,
      badgeCount: document.querySelectorAll('.selected-tag-badge').length,
    };
  })()`);
  out.push(['选中态样式', selState.result.value]);

  // 点击预览徽章 → 取消勾选
  const unsel = await E(`(() => {
    const badge = document.querySelector('.selected-tag-badge');
    if (!badge) return { err: '无预览徽章' };
    badge.click();
    return { removed: true };
  })()`);
  out.push(['预览徽章移除', unsel.result.value]);
  await sleep(400);
  const unselState = await E(`document.querySelectorAll('.selected-tag-badge').length`);
  out.push(['移除后徽章数', unselState.result.value]);

  // 新建标签
  const create = await E(`(() => {
    const input = document.querySelector('.tag-edit-input');
    const btn = [...document.querySelectorAll('.add-preset-tag-bar button')].find(b => b.textContent.includes('新建'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'UI测试标签');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    return { inputDisabled: btn.disabled };
  })()`);
  out.push(['新建标签', create.result.value]);
  await sleep(500);
  const created = await E(`[...document.querySelectorAll('.tag-toggle-name')].some(n => n.textContent === 'UI测试标签')`);
  out.push(['新标签出现在标签库', created.result.value]);

  // 保存
  const save = await E(`(() => {
    const btn = [...document.querySelectorAll('.tag-edit-footer button')].find(b => b.textContent.includes('保存'));
    btn.click();
    return true;
  })()`);
  out.push(['保存', save.result.value]);
  await sleep(800);
  const afterSave = await E(`(() => {
    const m = document.querySelector('.tag-edit-modal');
    const card = [...document.querySelectorAll('.account-card')].find(c => c.querySelector('.account-tag-chip'));
    const chip = card?.querySelector('.account-tag-chip');
    const cs = chip ? getComputedStyle(chip) : null;
    return {
      modalClosed: !m,
      cardHasTagChip: !!chip,
      chipText: chip?.textContent || '',
      chipBg: cs?.backgroundColor || '',
      chipColor: cs?.color || '',
      chipRadius: cs?.borderRadius || '',
      addBtnText: card?.querySelector('.add-tag-chip-btn')?.textContent.trim() || '',
    };
  })()`);
  out.push(['保存后卡片', afterSave.result.value]);

  // 卡片标签筛选态（点击卡片上的标签 chip → active 高亮 + 筛选条）
  const filter = await E(`(() => {
    const chip = document.querySelector('.account-tag-chip');
    if (!chip) return { err: '无卡片标签' };
    chip.click();
    return true;
  })()`);
  out.push(['点击卡片标签筛选', filter.result.value]);
  await sleep(500);
  const filterState = await E(`(() => {
    const chip = document.querySelector('.account-tag-chip.active');
    const bar = document.querySelector('.account-tag-active-bar');
    const cs = chip ? getComputedStyle(chip) : null;
    return { hasActive: !!chip, chipBg: cs?.backgroundColor, chipColor: cs?.color, hasFilterBar: !!bar };
  })()`);
  out.push(['筛选态', filterState.result.value]);

  // 主题适配：切到 dracula 再开弹窗看配色
  await E(`document.documentElement.setAttribute('data-theme','dracula'); true`);
  await sleep(300);
  const themeProbe = await E(`(() => {
    const btn = [...document.querySelectorAll('.account-card button')].find(b => b.textContent.includes('标签'));
    btn?.click();
    return !!btn;
  })()`);
  out.push(['暗色主题打开弹窗', themeProbe.result.value]);
  await sleep(600);
  const darkProbe = await E(`(() => {
    const m = document.querySelector('.tag-edit-modal');
    const sel = document.querySelector('.tag-toggle-chip');
    return {
      modalBg: getComputedStyle(m).backgroundColor,
      chipBg: getComputedStyle(sel).backgroundColor,
      tipBg: getComputedStyle(document.querySelector('.tag-edit-tip')).backgroundColor,
    };
  })()`);
  out.push(['暗色主题配色', darkProbe.result.value]);
  await E(`document.documentElement.removeAttribute('data-theme'); true`);

  for (const [k, v] of out) console.log(`[${k}]`, JSON.stringify(v));
  cdp.ws.close();
  process.exit(0);
})().catch(e => { console.error('[TEST] 失败:', e.message); process.exit(1); });
