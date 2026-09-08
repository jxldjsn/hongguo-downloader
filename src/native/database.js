/**
 * 持久化数据库层（sql.js / SQLite）
 *
 * 全部应用数据（监控用户/视频/历史时序/事件/账号/下载任务/配置）落 SQLite。
 * sql.js 是内存数据库，持久化靠 db.export() 写回磁盘文件：
 *   - 写操作同步执行 SQL，标记 dirty
 *   - flushNow() 立即把内存库 export 成 Buffer，原子写（临时文件 + rename）
 *   - 关键写操作（增删监控/账号/任务/配置）调用方应显式 flushNow() 落盘
 *
 * 返回的数据 shape 与原 electron-store / localStorage 保持一致，前端无需改动。
 */

const path = require('path');
const fs = require('fs');
const {
  buildTaskPayload,
  applyTaskPayload,
} = require('./download/taskPayload');

let SQL = null;        // sql.js 工厂
let db = null;         // SQL.Database 实例（内存）
let dbPath = '';       // 磁盘文件路径
let flushTimer = null; // 防抖定时器
let dirty = false;
let configuredSecretStore = null;

function configureSecretStore(secretStore) {
  if (!secretStore
    || typeof secretStore.get !== 'function'
    || typeof secretStore.set !== 'function'
    || typeof secretStore.delete !== 'function') {
    throw new TypeError('secretStore must provide get/set/delete');
  }
  configuredSecretStore = secretStore;
}

function isSecretKVKey(key) {
  return typeof key === 'string' && key.startsWith('cookie_');
}

// ===== 初始化 =====

/**
 * 初始化数据库。必须在 app.ready 之后调用（用到 app.getPath）。
 * @param {Electron.App} electronApp
 * @param {object} store  electron-store 实例（用于一次性迁移旧数据）
 */
async function initDatabase(electronApp, store) {
  const initSqlJs = require('sql.js');
  // wasm 路径解析：开发环境在 node_modules，打包后经 asarUnpack 在 app.asar.unpacked
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
  SQL = await initSqlJs({ locateFile: () => wasmPath });

  dbPath = path.join(electronApp.getPath('userData'), 'app.db');

  let loaded = false;
  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      loaded = true;
      console.log('[DB] 已加载现有数据库:', dbPath);
    } catch (err) {
      // 损坏：备份后重建，不让应用启动失败
      const corruptPath = dbPath + '.corrupt-' + Date.now();
      try { fs.renameSync(dbPath, corruptPath); } catch (_) { /* ignore */ }
      console.error('[DB] 数据库文件损坏，已备份为', corruptPath, '错误:', err.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    console.log('[DB] 创建新数据库:', dbPath);
  }

  createTables();
  // 迁移：给旧库的 account_works / work_stats_history 补充新增列（播放/分享/收藏）
  migrateAccountWorksColumns();
  // 迁移：给旧库 accounts 表补 group_id 列（分组功能）
  migrateAccountsColumns();
  // 迁移：给旧库 download_tasks 表补 platform 列（平台名称持久化）
  migrateDownloadTasksColumns();
  // 迁移：给旧库 monitor_users / monitor_videos 补分组/备注/标签/置顶列
  migrateMonitorColumns();
  // 迁移：给旧库 account_groups 补 color/scope 列
  migrateGroupsColumns();
  // 迁移：给旧库 my_accounts 补统计列
  migrateMyAccountsColumns();

  // 首次创建（未加载过文件）时尝试从 electron-store 迁移旧数据
  if (!loaded) {
    migrateFromStore(store);
  }

  // 旧版本把「我的账号」Cookie 明文存在表内。主程序配置安全存储后，
  // 启动时将其迁到加密 KV，并把旧列清空。
  migrateMyAccountSecrets();

  flushNow();
  return db;
}

// 兼容旧库：为 account_works / work_stats_history 增量补充新列（幂等，已存在则跳过）
function migrateAccountWorksColumns() {
  const addColIfMissing = (table, col, type) => {
    const cols = all(`PRAGMA table_info(${table})`).map(r => r.name);
    if (!cols.includes(col)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  };
  addColIfMissing('account_works', 'play_count', 'INTEGER');
  addColIfMissing('account_works', 'share_count', 'INTEGER');
  addColIfMissing('account_works', 'collect_count', 'INTEGER');
  addColIfMissing('work_stats_history', 'play_count', 'INTEGER');
  addColIfMissing('work_stats_history', 'share_count', 'INTEGER');
  addColIfMissing('work_stats_history', 'collect_count', 'INTEGER');
}

// 兼容旧库：为 accounts 表增量补充 group_id / pinned / tags / remark 列（幂等）
function migrateAccountsColumns() {
  const addColIfMissing = (col, type) => {
    const cols = all(`PRAGMA table_info(accounts)`).map(r => r.name);
    if (!cols.includes(col)) {
      db.run(`ALTER TABLE accounts ADD COLUMN ${col} ${type}`);
    }
  };
  addColIfMissing('group_id', 'TEXT');
  addColIfMissing('pinned', 'INTEGER DEFAULT 0');
  addColIfMissing('tags', 'TEXT');
  addColIfMissing('remark', 'TEXT');
  // 索引（IF NOT EXISTS，幂等）
  db.run(`CREATE INDEX IF NOT EXISTS idx_acc_group ON accounts(group_id)`);
}

// 兼容旧库：为 download_tasks 表增量补充任务与载荷列（幂等）
function migrateDownloadTasksColumns() {
  const cols = all(`PRAGMA table_info(download_tasks)`).map(r => r.name);
  const addColumnIfMissing = (name, type) => {
    if (!cols.includes(name)) {
      db.run(`ALTER TABLE download_tasks ADD COLUMN ${name} ${type}`);
      cols.push(name);
    }
  };
  if (!cols.includes('platform')) {
    db.run(`ALTER TABLE download_tasks ADD COLUMN platform TEXT`);
    cols.push('platform');
    // 旧任务回填：从 video_info JSON 里的 platform 字段补
    const rows = all(`SELECT id, video_info FROM download_tasks`);
    for (const r of rows) {
      let pf = '';
      try { pf = (JSON.parse(r.video_info || 'null') || {}).platform || ''; } catch (_) { /* ignore */ }
      if (pf) db.run(`UPDATE download_tasks SET platform=? WHERE id=?`, [pf, r.id]);
    }
  }
  addColumnIfMissing('batch_id', 'TEXT');
  addColumnIfMissing('batch_info', 'TEXT');
  addColumnIfMissing('custom_dir', 'TEXT');
  addColumnIfMissing('payload_json', 'TEXT');
  addColumnIfMissing('payload_version', 'INTEGER DEFAULT 1');
  addColumnIfMissing('revision', 'INTEGER DEFAULT 0');
  addColumnIfMissing('updated_time', 'INTEGER DEFAULT 0');
}

// 兼容旧库：为 monitor_users / monitor_videos 补充分组/备注/标签/置顶列（幂等）
function migrateMonitorColumns() {
  const addColIfMissing = (table, col, type) => {
    const cols = all(`PRAGMA table_info(${table})`).map(r => r.name);
    if (!cols.includes(col)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  };
  ['monitor_users', 'monitor_videos'].forEach(t => {
    addColIfMissing(t, 'group_id', 'TEXT');
    addColIfMissing(t, 'remark', 'TEXT');
    addColIfMissing(t, 'tags', 'TEXT');
    addColIfMissing(t, 'pinned', 'INTEGER DEFAULT 0');
  });
}

// 兼容旧库：为 account_groups 补充 color / scope 列并重建唯一索引（幂等）
function migrateGroupsColumns() {
  const cols = all(`PRAGMA table_info(account_groups)`).map(r => r.name);
  if (!cols.includes('color')) {
    db.run(`ALTER TABLE account_groups ADD COLUMN color TEXT`);
  }
  if (!cols.includes('scope')) {
    db.run(`ALTER TABLE account_groups ADD COLUMN scope TEXT NOT NULL DEFAULT 'account'`);
  }
  // 老数据全部归为 account scope
  db.run(`UPDATE account_groups SET scope='account' WHERE scope IS NULL OR scope=''`);
  // 重建唯一索引（name + scope），允许不同 scope 同名
  db.run(`DROP INDEX IF EXISTS idx_ag_name_scope`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ag_name_scope ON account_groups(name, scope)`);
}

// 兼容旧库：为 my_accounts 表增量补充列（幂等）
function migrateMyAccountsColumns() {
  const addColIfMissing = (col, type) => {
    const cols = all(`PRAGMA table_info(my_accounts)`).map(r => r.name);
    if (!cols.includes(col)) {
      db.run(`ALTER TABLE my_accounts ADD COLUMN ${col} ${type}`);
    }
  };
  addColIfMissing('unique_id', 'TEXT');
  addColIfMissing('signature', 'TEXT');
  addColIfMissing('follower_count', 'INTEGER');
  addColIfMissing('following_count', 'INTEGER');
  addColIfMissing('total_favorited', 'INTEGER');
  addColIfMissing('aweme_count', 'INTEGER');
  addColIfMissing('favoriting_count', 'INTEGER');
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_users (
      sec_user_id TEXT PRIMARY KEY,
      nickname TEXT, avatar TEXT, unique_id TEXT,
      follower_count INTEGER, aweme_count INTEGER,
      last_aweme_time INTEGER, last_aweme_id TEXT,
      notify_follower INTEGER, notify_new_video INTEGER,
      added_at INTEGER, last_checked INTEGER,
      group_id TEXT, remark TEXT, tags TEXT, pinned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS follower_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sec_user_id TEXT, time INTEGER, value INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fh_user ON follower_history(sec_user_id, time);

    CREATE TABLE IF NOT EXISTS monitor_videos (
      aweme_id TEXT PRIMARY KEY,
      desc_text TEXT, author TEXT, cover TEXT,
      digg_count INTEGER, comment_count INTEGER,
      added_at INTEGER, last_checked INTEGER,
      group_id TEXT, remark TEXT, tags TEXT, pinned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS video_stats_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT, time INTEGER, digg_count INTEGER, comment_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vsh_video ON video_stats_history(aweme_id, time);

    CREATE TABLE IF NOT EXISTS monitor_events (
      id TEXT PRIMARY KEY, time INTEGER, read_flag INTEGER, type TEXT, payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evt_time ON monitor_events(time DESC);

    CREATE TABLE IF NOT EXISTS accounts (
      sec_user_id TEXT PRIMARY KEY,
      nickname TEXT, unique_id TEXT, avatar TEXT, signature TEXT,
      follower_count INTEGER, following_count INTEGER, total_favorited INTEGER,
      aweme_count INTEGER, favoriting_count INTEGER, added_time INTEGER
    );

    -- 我的账号（运营专区）：绑定自己的抖音账号，每个账号存独立 cookie，
    -- 用它抓自己的作品才能看到播放量(play_count)。uid 是抖音 uid(数字ID)，可重复登录覆盖。
    CREATE TABLE IF NOT EXISTS my_accounts (
      uid TEXT PRIMARY KEY,
      sec_uid TEXT,
      nickname TEXT,
      avatar TEXT,
      cookie TEXT,
      added_time INTEGER,
      unique_id TEXT,
      signature TEXT,
      follower_count INTEGER,
      following_count INTEGER,
      total_favorited INTEGER,
      aweme_count INTEGER,
      favoriting_count INTEGER
    );

    -- 账号分组：独立表存分组，accounts.group_id 关联（NULL = 未分组）
    -- color: 分组颜色；scope: 区分 account/monitor_user/monitor_video
    CREATE TABLE IF NOT EXISTS account_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_time INTEGER,
      color TEXT,
      scope TEXT NOT NULL DEFAULT 'account'
    );
    -- 注意：idx_ag_name_scope 索引不在 createTables 里建，而是由 migrateGroupsColumns()
    -- 在 ALTER 补完 color/scope 列之后统一建。否则旧库（account_groups 已存在但无 scope 列）
    -- 在这里建索引会因 scope 列不存在而报 "no such column: scope"，导致启动失败。

    -- 账号增速历史：每个监控周期一条，记录粉丝/获赞/作品数等时序
    CREATE TABLE IF NOT EXISTS account_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sec_user_id TEXT, time INTEGER,
      follower_count INTEGER, following_count INTEGER,
      total_favorited INTEGER, aweme_count INTEGER, favoriting_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ah_user ON account_history(sec_user_id, time);

    -- 账号下的作品清单（每周期用列表接口全量刷新）
    CREATE TABLE IF NOT EXISTS account_works (
      aweme_id TEXT PRIMARY KEY,
      sec_user_id TEXT, desc_text TEXT, cover TEXT, create_time INTEGER,
      digg_count INTEGER, comment_count INTEGER,
      play_count INTEGER, share_count INTEGER, collect_count INTEGER,
      last_checked INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_aw_user ON account_works(sec_user_id);

    -- 单个作品的统计时序（点赞/评论/播放/分享随时间变化）
    CREATE TABLE IF NOT EXISTS work_stats_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT, time INTEGER,
      digg_count INTEGER, comment_count INTEGER,
      play_count INTEGER, share_count INTEGER, collect_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wsh_video ON work_stats_history(aweme_id, time);

    CREATE TABLE IF NOT EXISTS download_tasks (
      id TEXT PRIMARY KEY, filename TEXT, url TEXT, save_path TEXT,
      video_info TEXT, status TEXT, progress INTEGER,
      received_bytes INTEGER, total_bytes INTEGER,
      start_time INTEGER, end_time INTEGER, type TEXT, error TEXT, skipped INTEGER,
      platform TEXT, batch_id TEXT, batch_info TEXT, custom_dir TEXT,
      payload_json TEXT, payload_version INTEGER DEFAULT 1,
      revision INTEGER DEFAULT 0, updated_time INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY, value TEXT
    );

    -- 主页下载历史记录：按 sec_user_id 去重（INSERT OR REPLACE 覆盖）
    -- videos 存完整 aweme 数组的 JSON 字符串（参考 download_tasks.video_info 模式）
    -- 收藏作品用 sec_user_id:collection 作主键，避免和发布作品冲突
    CREATE TABLE IF NOT EXISTS profile_history (
      sec_user_id TEXT PRIMARY KEY,
      nickname TEXT, avatar TEXT, unique_id TEXT,
      videos TEXT,
      video_count INTEGER,
      download_type TEXT,
      source_url TEXT,
      platform TEXT,
      created_time INTEGER,
      updated_time INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ph_time ON profile_history(updated_time DESC);
  `);
}

// ===== 持久化（原子写） =====

function markDirty() {
  dirty = true;
}

function createPersistenceError(cause, message = '数据保存失败，请检查磁盘空间或目录权限') {
  const error = new Error(message);
  error.code = 'PERSIST_FAILED';
  if (cause) {
    error.cause = cause;
    if (cause.code) error.systemCode = cause.code;
  }
  return error;
}

/**
 * 立即把内存库写回磁盘（原子写：先写临时文件再 rename 覆盖）。
 */
function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!db || !dbPath) {
    throw createPersistenceError(null, '数据存储尚未初始化');
  }
  try {
    const data = db.export(); // Uint8Array
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, dbPath); // 原子替换
    dirty = false;
    return true;
  } catch (err) {
    dirty = true;
    console.error('[DB] flush 失败:', err && err.code ? String(err.code) : 'IO_ERROR');
    throw createPersistenceError(err);
  }
}

/**
 * 防抖 flush：500ms 内多次写合并为一次落盘。
 */
function scheduleFlush() {
  markDirty();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushNow();
    } catch (_) {
      // flushNow already recorded one sanitized diagnostic; keep dirty for retry.
    }
  }, 500);
}

function getPersistenceState() {
  const timer = flushTimer !== null;
  return Object.freeze({ dirty, timer, flushScheduled: timer });
}

// 应用退出前确保落盘（由 main.js 调用）
function flushBeforeQuit() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushNow();
}

// ===== 一次性迁移（从 electron-store） =====

function migrateFromStore(store) {
  if (!store) return;
  let migrated = 0;
  try {
    // 监控用户 + 粉丝历史
    const users = store.get('monitor_users', []);
    if (Array.isArray(users) && users.length) {
      for (const u of users) {
        upsertMonitorUserRaw(u);
        if (Array.isArray(u.followerHistory)) {
          for (const p of u.followerHistory) {
            db.run('INSERT INTO follower_history (sec_user_id, time, value) VALUES (?,?,?)',
              [u.secUserId, p.time, p.value]);
          }
        }
      }
      migrated += users.length;
      store.set('monitor_users_migrated', users); // 备份，不删原 key
    }

    // 监控视频 + 统计历史
    const videos = store.get('monitor_videos', []);
    if (Array.isArray(videos) && videos.length) {
      for (const v of videos) {
        upsertMonitorVideoRaw(v);
        if (Array.isArray(v.statsHistory)) {
          for (const p of v.statsHistory) {
            db.run('INSERT INTO video_stats_history (aweme_id, time, digg_count, comment_count) VALUES (?,?,?,?)',
              [v.awemeId, p.time, p.diggCount, p.commentCount]);
          }
        }
      }
      migrated += videos.length;
      store.set('monitor_videos_migrated', videos);
    }

    // 监控事件
    const events = store.get('monitor_events', []);
    if (Array.isArray(events) && events.length) {
      for (const e of events) {
        const { id, time, read, type, ...payload } = e;
        db.run('INSERT OR REPLACE INTO monitor_events (id, time, read_flag, type, payload) VALUES (?,?,?,?,?)',
          [String(id), time || Date.now(), read ? 1 : 0, type || '', JSON.stringify(payload)]);
      }
      migrated += events.length;
      store.set('monitor_events_migrated', events);
    }

    // 配置类进 kv
    const kvKeys = ['settings', 'monitor_config', 'control_panel_url', 'cookie_douyin'];
    for (const k of kvKeys) {
      const v = store.get(k, undefined);
      if (v !== undefined) {
        setKV(k, v);
      }
    }

    // 下载任务
    const tasks = store.get('downloadTasks', []);
    if (Array.isArray(tasks) && tasks.length) {
      for (const t of tasks) {
        upsertDownloadTaskRaw(t);
      }
      store.set('downloadTasks_migrated', tasks);
    }

    console.log('[DB] 从 electron-store 迁移完成，共', migrated, '条记录');
  } catch (err) {
    console.error('[DB] 迁移失败（部分数据可能未迁移）:', err.message);
  }
}

// ===== 监控用户 CRUD（返回 shape 兼容前端：followerHistory 数组） =====

function upsertMonitorUserRaw(u) {
  db.run(`INSERT OR REPLACE INTO monitor_users
    (sec_user_id, nickname, avatar, unique_id, follower_count, aweme_count,
     last_aweme_time, last_aweme_id, notify_follower, notify_new_video, added_at, last_checked,
     group_id, remark, tags, pinned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [u.secUserId, u.nickname || '', u.avatar || '', u.uniqueId || '',
     u.followerCount || 0, u.awemeCount || 0,
     u.lastAwemeTime || 0, u.lastAwemeId || '',
     u.notifyFollower ? 1 : 0, u.notifyNewVideo ? 1 : 0,
     u.addedAt || Date.now(), u.lastChecked || Date.now(),
     u.groupId || null, u.remark || '', Array.isArray(u.tags) ? JSON.stringify(u.tags) : (u.tags || ''),
     u.pinned ? 1 : 0]);
}

function listMonitorUsers() {
  const rows = all(`SELECT * FROM monitor_users ORDER BY pinned DESC, added_at DESC`);
  return rows.map(rowToMonitorUser);
}

function rowToMonitorUser(r) {
  const histRows = all(`SELECT time, value FROM follower_history WHERE sec_user_id=? ORDER BY time ASC`, [r.sec_user_id]);
  let tags = [];
  try { tags = r.tags ? (Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags)) : []; } catch (e) { tags = []; }
  return {
    secUserId: r.sec_user_id,
    nickname: r.nickname,
    avatar: r.avatar,
    uniqueId: r.unique_id,
    followerCount: r.follower_count,
    followerHistory: histRows.map(h => ({ time: h.time, value: h.value })),
    awemeCount: r.aweme_count,
    lastAwemeTime: r.last_aweme_time,
    lastAwemeId: r.last_aweme_id,
    notifyFollower: !!r.notify_follower,
    notifyNewVideo: !!r.notify_new_video,
    addedAt: r.added_at,
    lastChecked: r.last_checked,
    groupId: r.group_id || null,
    remark: r.remark || '',
    tags,
    pinned: !!r.pinned,
  };
}

function addMonitorUser(u) {
  upsertMonitorUserRaw(u);
  // 初始历史点
  db.run('INSERT INTO follower_history (sec_user_id, time, value) VALUES (?,?,?)',
    [u.secUserId, u.lastChecked || Date.now(), u.followerCount || 0]);
  flushNow();
}

function removeMonitorUser(secUserId) {
  db.run('DELETE FROM monitor_users WHERE sec_user_id=?', [secUserId]);
  db.run('DELETE FROM follower_history WHERE sec_user_id=?', [secUserId]);
  flushNow();
}

function updateMonitorUser(secUserId, patch) {
  const cur = get(`SELECT * FROM monitor_users WHERE sec_user_id=?`, [secUserId]);
  if (!cur) return;
  const merged = {
    ...rowToMonitorUser(cur),
    ...patch,
  };
  upsertMonitorUserRaw(merged);
  flushNow();
}

// checkMonitorUser 调用：更新用户字段 + 追加粉丝历史点
function updateMonitorUserSnapshot(user) {
  upsertMonitorUserRaw(user);
  // 追加历史点（值未变时也记录时间，便于曲线密度）
  db.run('INSERT INTO follower_history (sec_user_id, time, value) VALUES (?,?,?)',
    [user.secUserId, user.lastChecked || Date.now(), user.followerCount || 0]);
  scheduleFlush();
}

// 整体持久化监控状态（runMonitorCycle 末尾调用）：以内存数组为准覆盖 DB
// 注意：分组/备注/标签/置顶是用户手动设置的，监控刷新时不能丢失。
//       这里先从 DB 读出这些字段合并进内存对象，再 upsert，避免覆盖用户设置。
function persistMonitorState(users, videos) {
  if (!Array.isArray(users) || !Array.isArray(videos)) return;
  // 用户
  db.run('DELETE FROM monitor_users');
  db.run('DELETE FROM follower_history');
  for (const u of users) {
    // 合并 DB 中已有的分组/备注/标签/置顶（监控刷新的内存对象通常不带这些字段）
    const oldRow = get(`SELECT group_id, remark, tags, pinned FROM monitor_users WHERE sec_user_id=?`, [u.secUserId]);
    if (oldRow) {
      u.groupId = u.groupId ?? (oldRow.group_id || null);
      u.remark = u.remark ?? (oldRow.remark || '');
      u.tags = u.tags ?? (oldRow.tags || []);
      u.pinned = u.pinned ?? !!oldRow.pinned;
    }
    upsertMonitorUserRaw(u);
    if (Array.isArray(u.followerHistory)) {
      for (const p of u.followerHistory) {
        db.run('INSERT INTO follower_history (sec_user_id, time, value) VALUES (?,?,?)',
          [u.secUserId, p.time, p.value]);
      }
    }
  }
  // 视频
  db.run('DELETE FROM monitor_videos');
  db.run('DELETE FROM video_stats_history');
  for (const v of videos) {
    const oldRow = get(`SELECT group_id, remark, tags, pinned FROM monitor_videos WHERE aweme_id=?`, [v.awemeId]);
    if (oldRow) {
      v.groupId = v.groupId ?? (oldRow.group_id || null);
      v.remark = v.remark ?? (oldRow.remark || '');
      v.tags = v.tags ?? (oldRow.tags || []);
      v.pinned = v.pinned ?? !!oldRow.pinned;
    }
    upsertMonitorVideoRaw(v);
    if (Array.isArray(v.statsHistory)) {
      for (const p of v.statsHistory) {
        db.run('INSERT INTO video_stats_history (aweme_id, time, digg_count, comment_count) VALUES (?,?,?,?)',
          [v.awemeId, p.time, p.diggCount, p.commentCount]);
      }
    }
  }
  flushNow();
}

function getMonitorUser(secUserId) {
  const r = get(`SELECT * FROM monitor_users WHERE sec_user_id=?`, [secUserId]);
  return r ? rowToMonitorUser(r) : null;
}

// ===== 监控视频 CRUD =====

function upsertMonitorVideoRaw(v) {
  db.run(`INSERT OR REPLACE INTO monitor_videos
    (aweme_id, desc_text, author, cover, digg_count, comment_count, added_at, last_checked,
     group_id, remark, tags, pinned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [v.awemeId, v.desc || '', v.author || '', v.cover || '',
     v.diggCount || 0, v.commentCount || 0,
     v.addedAt || Date.now(), v.lastChecked || Date.now(),
     v.groupId || null, v.remark || '', Array.isArray(v.tags) ? JSON.stringify(v.tags) : (v.tags || ''),
     v.pinned ? 1 : 0]);
}

function listMonitorVideos() {
  const rows = all(`SELECT * FROM monitor_videos ORDER BY pinned DESC, added_at DESC`);
  return rows.map(rowToMonitorVideo);
}

function rowToMonitorVideo(r) {
  const histRows = all(`SELECT time, digg_count, comment_count FROM video_stats_history WHERE aweme_id=? ORDER BY time ASC`, [r.aweme_id]);
  let tags = [];
  try { tags = r.tags ? (Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags)) : []; } catch (e) { tags = []; }
  return {
    awemeId: r.aweme_id,
    desc: r.desc_text,
    author: r.author,
    cover: r.cover,
    diggCount: r.digg_count,
    commentCount: r.comment_count,
    statsHistory: histRows.map(h => ({ time: h.time, diggCount: h.digg_count, commentCount: h.comment_count })),
    addedAt: r.added_at,
    lastChecked: r.last_checked,
    groupId: r.group_id || null,
    remark: r.remark || '',
    tags,
    pinned: !!r.pinned,
  };
}

function addMonitorVideo(v) {
  upsertMonitorVideoRaw(v);
  db.run('INSERT INTO video_stats_history (aweme_id, time, digg_count, comment_count) VALUES (?,?,?,?)',
    [v.awemeId, v.lastChecked || Date.now(), v.diggCount || 0, v.commentCount || 0]);
  flushNow();
}

function removeMonitorVideo(awemeId) {
  db.run('DELETE FROM monitor_videos WHERE aweme_id=?', [awemeId]);
  db.run('DELETE FROM video_stats_history WHERE aweme_id=?', [awemeId]);
  flushNow();
}

function updateMonitorVideoSnapshot(video) {
  upsertMonitorVideoRaw(video);
  db.run('INSERT INTO video_stats_history (aweme_id, time, digg_count, comment_count) VALUES (?,?,?,?)',
    [video.awemeId, video.lastChecked || Date.now(), video.diggCount || 0, video.commentCount || 0]);
  scheduleFlush();
}

// ===== 监控事件 =====

function addMonitorEvent(evt) {
  const { id, time, read, type, ...payload } = evt;
  const eid = String(id);
  db.run('INSERT OR REPLACE INTO monitor_events (id, time, read_flag, type, payload) VALUES (?,?,?,?,?)',
    [eid, time || Date.now(), read ? 1 : 0, type || '', JSON.stringify(payload)]);
  // 保留最新 200 条（与原逻辑一致）
  db.run('DELETE FROM monitor_events WHERE id NOT IN (SELECT id FROM monitor_events ORDER BY time DESC LIMIT 200)');
  scheduleFlush();
}

function listMonitorEvents() {
  const rows = all(`SELECT * FROM monitor_events ORDER BY time DESC`);
  return rows.map(r => {
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch (_) { /* ignore */ }
    return { id: r.id, time: r.time, read: !!r.read_flag, type: r.type, ...payload };
  });
}

function clearMonitorEvents() {
  db.run('DELETE FROM monitor_events');
  flushNow();
}

function markMonitorEventsRead() {
  db.run('UPDATE monitor_events SET read_flag=1');
  flushNow();
}

// ===== 监控配置 =====

// 事件类型开关默认值（全开，老用户升级平滑）
const DEFAULT_MONITOR_TYPES = { follower: true, new_video: true, video_digg: true };
const DEFAULT_PUSH_TYPES = { follower: true, new_video: true, video_digg: true };
// Server酱 微信推送默认配置（默认关闭，老用户升级不会突然推送）
const DEFAULT_SERVER_CHAN = { enabled: false, sctkey: '' };

// 读取监控配置：补齐缺失字段，保证老数据平滑升级
function getMonitorConfig() {
  const base = getKV('monitor_config') || { enabled: true, intervalMinutes: 10 };
  // 补齐 monitorTypes / pushTypes / serverChan（按字段补，已存在的不覆盖）
  base.monitorTypes = Object.assign({}, DEFAULT_MONITOR_TYPES, base.monitorTypes || {});
  base.pushTypes = Object.assign({}, DEFAULT_PUSH_TYPES, base.pushTypes || {});
  base.serverChan = Object.assign({}, DEFAULT_SERVER_CHAN, base.serverChan || {});
  return base;
}

function setMonitorConfig(cfg) {
  setKV('monitor_config', cfg);
  flushNow();
}

// ===== 账号管理 =====

function listAccounts() {
  return all(`SELECT * FROM accounts ORDER BY pinned DESC, added_time DESC`).map(r => ({
    sec_user_id: r.sec_user_id,
    nickname: r.nickname,
    unique_id: r.unique_id,
    avatar: r.avatar,
    signature: r.signature,
    follower_count: r.follower_count,
    following_count: r.following_count,
    total_favorited: r.total_favorited,
    aweme_count: r.aweme_count,
    favoriting_count: r.favoriting_count,
    added_time: r.added_time,
    group_id: r.group_id || null,
    pinned: r.pinned || 0,
    tags: r.tags || '',
    remark: r.remark || '',
  }));
}

function addAccount(acc) {
  // INSERT OR REPLACE 会整行替换，group_id/pinned/tags/remark 若未传则保留已有值（避免刷新账号时丢数据）
  const existing = get(`SELECT group_id, pinned, tags, remark FROM accounts WHERE sec_user_id=?`, [acc.sec_user_id]);
  const groupId = acc.group_id !== undefined ? acc.group_id : (existing ? existing.group_id : null);
  const pinned = acc.pinned !== undefined ? (acc.pinned ? 1 : 0) : (existing ? (existing.pinned || 0) : 0);
  const tags = acc.tags !== undefined ? acc.tags : (existing ? (existing.tags || '') : '');
  const remark = acc.remark !== undefined ? acc.remark : (existing ? (existing.remark || '') : '');

  db.run(`INSERT OR REPLACE INTO accounts
    (sec_user_id, nickname, unique_id, avatar, signature, follower_count, following_count,
     total_favorited, aweme_count, favoriting_count, added_time, group_id, pinned, tags, remark)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [acc.sec_user_id, acc.nickname || '', acc.unique_id || '', acc.avatar || '',
     acc.signature || '', acc.follower_count || 0, acc.following_count || 0,
     acc.total_favorited || 0, acc.aweme_count || 0, acc.favoriting_count || 0,
     acc.added_time || Date.now(), groupId, pinned, tags, remark]);
  flushNow();
}

function updateAccountMeta(secUserId, patch) {
  const existing = get(`SELECT * FROM accounts WHERE sec_user_id=?`, [secUserId]);
  if (!existing) return;
  const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (existing.pinned || 0);
  const tags = patch.tags !== undefined ? patch.tags : (existing.tags || '');
  const remark = patch.remark !== undefined ? patch.remark : (existing.remark || '');
  const groupId = patch.group_id !== undefined ? patch.group_id : existing.group_id;

  db.run(`UPDATE accounts SET pinned=?, tags=?, remark=?, group_id=? WHERE sec_user_id=?`,
    [pinned, tags, remark, groupId, secUserId]);
  flushNow();
}

function removeAccount(secUserId) {
  db.run('DELETE FROM accounts WHERE sec_user_id=?', [secUserId]);
  db.run('DELETE FROM account_history WHERE sec_user_id=?', [secUserId]);
  // 作品时序：先收集该账号下的作品 id，再删
  const workIds = all('SELECT aweme_id FROM account_works WHERE sec_user_id=?', [secUserId]).map(r => r.aweme_id);
  db.run('DELETE FROM account_works WHERE sec_user_id=?', [secUserId]);
  for (const wid of workIds) {
    db.run('DELETE FROM work_stats_history WHERE aweme_id=?', [wid]);
  }
  flushNow();
}

// ===== 我的账号（运营专区：绑定自己的抖音账号，看播放量） =====

function listMyAccounts() {
  return all('SELECT * FROM my_accounts ORDER BY added_time DESC').map(r => ({
    uid: r.uid,
    sec_uid: r.sec_uid,
    nickname: r.nickname || '',
    avatar: r.avatar || '',
    added_time: r.added_time || 0,
    unique_id: r.unique_id || '',
    signature: r.signature || '',
    follower_count: r.follower_count || 0,
    following_count: r.following_count || 0,
    total_favorited: r.total_favorited || 0,
    aweme_count: r.aweme_count || 0,
    favoriting_count: r.favoriting_count || 0,
  }));
}

function addMyAccount(a) {
  // uid 为主键（抖音 uid 数字ID）。Cookie 单独走 Windows 安全存储，
  // 这里的旧 cookie 列只为数据库兼容保留，并始终写空值。
  const existing = get(`SELECT * FROM my_accounts WHERE uid=?`, [a.uid || '']);
  db.run(`INSERT OR REPLACE INTO my_accounts
    (uid, sec_uid, nickname, avatar, cookie, added_time,
     unique_id, signature, follower_count, following_count, total_favorited, aweme_count, favoriting_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [a.uid || '', a.sec_uid || '', a.nickname || '', a.avatar || '', '', a.added_time || Date.now(),
     a.unique_id ?? (existing ? existing.unique_id : ''),
     a.signature ?? (existing ? existing.signature : ''),
     a.follower_count ?? (existing ? existing.follower_count : 0),
     a.following_count ?? (existing ? existing.following_count : 0),
     a.total_favorited ?? (existing ? existing.total_favorited : 0),
     a.aweme_count ?? (existing ? existing.aweme_count : 0),
     a.favoriting_count ?? (existing ? existing.favoriting_count : 0)]);
  flushNow();
}

function removeMyAccount(uid) {
  db.run('DELETE FROM my_accounts WHERE uid=?', [uid]);
  deleteKV(myAccountSecretKey(uid));
  flushNow();
}

function myAccountSecretKey(uid) {
  return `cookie_my_account_${String(uid || '')}`;
}

function getMyAccountSecret(uid) {
  return getKV(myAccountSecretKey(uid), '');
}

function setMyAccountSecret(uid, value) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) throw new TypeError('uid is required');
  setKV(myAccountSecretKey(normalizedUid), String(value || ''));
  // 即使旧库仍有明文列，也在成功加密后立即清空。
  db.run('UPDATE my_accounts SET cookie=? WHERE uid=?', ['', normalizedUid]);
  markDirty();
  flushNow();
}

function migrateMyAccountSecrets() {
  if (!configuredSecretStore || !db) return 0;
  const legacyRows = all(`SELECT uid, cookie FROM my_accounts WHERE cookie IS NOT NULL AND cookie<>''`);
  let migrated = 0;
  for (const row of legacyRows) {
    const key = myAccountSecretKey(row.uid);
    const existing = configuredSecretStore.get(key, '');
    if (!existing) configuredSecretStore.set(key, row.cookie);
    db.run('UPDATE my_accounts SET cookie=? WHERE uid=?', ['', row.uid]);
    markDirty();
    migrated++;
  }
  return migrated;
}

function clearMyAccountSecrets() {
  for (const key of listKVKeys('cookie_my_account_')) deleteKV(key);
  db.run('UPDATE my_accounts SET cookie=?', ['']);
  markDirty();
  flushNow();
}

function updateAccount(secUserId, patch) {
  const cur = get(`SELECT * FROM accounts WHERE sec_user_id=?`, [secUserId]);
  if (!cur) return;
  const merged = {
    sec_user_id: cur.sec_user_id,
    nickname: cur.nickname, unique_id: cur.unique_id, avatar: cur.avatar,
    signature: cur.signature, follower_count: cur.follower_count,
    following_count: cur.following_count, total_favorited: cur.total_favorited,
    aweme_count: cur.aweme_count, favoriting_count: cur.favoriting_count,
    added_time: cur.added_time,
    group_id: cur.group_id,
    ...patch,
  };
  addAccount(merged);
}

// ===== 分组（accounts / monitor_users / monitor_videos 共用 account_groups 表，用 scope 区分） =====

function genId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 7);
}

// scope: 'account' | 'monitor_user' | 'monitor_video'，不传则返回全部
function listGroups(scope) {
  const where = scope ? `WHERE g.scope=?` : '';
  const params = scope ? [scope] : [];
  return all(`SELECT g.*,
      (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id AND g.scope='account') AS account_count,
      (SELECT COUNT(*) FROM monitor_users m WHERE m.group_id = g.id AND g.scope='monitor_user') AS monitor_user_count,
      (SELECT COUNT(*) FROM monitor_videos mv WHERE mv.group_id = g.id AND g.scope='monitor_video') AS monitor_video_count
    FROM account_groups g ${where} ORDER BY g.sort_order ASC, g.created_time ASC`, params).map(r => ({
    id: r.id,
    name: r.name,
    sort_order: r.sort_order,
    created_time: r.created_time,
    color: r.color || '',
    scope: r.scope || 'account',
    account_count: r.account_count || 0,
    monitor_user_count: r.monitor_user_count || 0,
    monitor_video_count: r.monitor_video_count || 0,
  }));
}

// arg: 字符串 name（兼容旧调用，scope=account）或对象 {name, color?, scope?}
function addGroup(arg) {
  const opts = typeof arg === 'string' ? { name: arg } : (arg || {});
  const trimmed = String(opts.name || '').trim();
  if (!trimmed) throw new Error('分组名不能为空');
  const scope = opts.scope || 'account';
  const color = opts.color || '';
  // 唯一性校验（按 scope）
  const dup = get(`SELECT id FROM account_groups WHERE name=? AND scope=?`, [trimmed, scope]);
  if (dup) throw new Error('分组名已存在');
  const id = genId();
  const now = Date.now();
  const maxOrder = get(`SELECT MAX(sort_order) AS m FROM account_groups WHERE scope=?`, [scope]);
  const sortOrder = (maxOrder && maxOrder.m != null) ? maxOrder.m + 1 : 0;
  db.run(`INSERT INTO account_groups (id, name, sort_order, created_time, color, scope) VALUES (?,?,?,?,?,?)`,
    [id, trimmed, sortOrder, now, color, scope]);
  flushNow();
  return listGroups(scope);
}

function renameGroup(id, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) throw new Error('分组名不能为空');
  const cur = get(`SELECT scope FROM account_groups WHERE id=?`, [id]);
  const scope = cur ? cur.scope : 'account';
  const dup = get(`SELECT id FROM account_groups WHERE name=? AND scope=? AND id<>?`, [trimmed, scope, id]);
  if (dup) throw new Error('分组名已存在');
  db.run(`UPDATE account_groups SET name=? WHERE id=?`, [trimmed, id]);
  flushNow();
  return listGroups(scope);
}

// 更新分组颜色
function updateGroupColor(id, color) {
  db.run(`UPDATE account_groups SET color=? WHERE id=?`, [color || '', id]);
  flushNow();
  const cur = get(`SELECT scope FROM account_groups WHERE id=?`, [id]);
  return listGroups(cur ? cur.scope : 'account');
}

function removeGroup(id) {
  // 先把该组下所有 scope 的成员归到未分组（group_id = NULL）
  db.run(`UPDATE accounts SET group_id=NULL WHERE group_id=?`, [id]);
  db.run(`UPDATE monitor_users SET group_id=NULL WHERE group_id=?`, [id]);
  db.run(`UPDATE monitor_videos SET group_id=NULL WHERE group_id=?`, [id]);
  const cur = get(`SELECT scope FROM account_groups WHERE id=?`, [id]);
  db.run(`DELETE FROM account_groups WHERE id=?`, [id]);
  flushNow();
  return listGroups(cur ? cur.scope : 'account');
}

function moveAccountToGroup(secUserId, groupId) {
  // groupId 为 null/空 -> 移到未分组
  const gid = groupId || null;
  db.run(`UPDATE accounts SET group_id=? WHERE sec_user_id=?`, [gid, secUserId]);
  flushNow();
}

// 监控用户移到分组
function moveMonitorUserToGroup(secUserId, groupId) {
  const gid = groupId || null;
  db.run(`UPDATE monitor_users SET group_id=? WHERE sec_user_id=?`, [gid, secUserId]);
  flushNow();
}

// 监控视频移到分组
function moveMonitorVideoToGroup(awemeId, groupId) {
  const gid = groupId || null;
  db.run(`UPDATE monitor_videos SET group_id=? WHERE aweme_id=?`, [gid, awemeId]);
  flushNow();
}

// 更新监控用户的备注/标签/置顶（不影响监控数据）
function updateMonitorUserMeta(secUserId, patch) {
  const sets = [];
  const params = [];
  if (patch.remark !== undefined) { sets.push('remark=?'); params.push(patch.remark || ''); }
  if (patch.tags !== undefined) {
    sets.push('tags=?');
    params.push(Array.isArray(patch.tags) ? JSON.stringify(patch.tags) : (patch.tags || ''));
  }
  if (patch.pinned !== undefined) { sets.push('pinned=?'); params.push(patch.pinned ? 1 : 0); }
  if (sets.length === 0) return;
  params.push(secUserId);
  db.run(`UPDATE monitor_users SET ${sets.join(',')} WHERE sec_user_id=?`, params);
  flushNow();
}

// 更新监控视频的备注/标签/置顶
function updateMonitorVideoMeta(awemeId, patch) {
  const sets = [];
  const params = [];
  if (patch.remark !== undefined) { sets.push('remark=?'); params.push(patch.remark || ''); }
  if (patch.tags !== undefined) {
    sets.push('tags=?');
    params.push(Array.isArray(patch.tags) ? JSON.stringify(patch.tags) : (patch.tags || ''));
  }
  if (patch.pinned !== undefined) { sets.push('pinned=?'); params.push(patch.pinned ? 1 : 0); }
  if (sets.length === 0) return;
  params.push(awemeId);
  db.run(`UPDATE monitor_videos SET ${sets.join(',')} WHERE aweme_id=?`, params);
  flushNow();
}

// ===== 账号增速历史 =====

/**
 * 追加一条账号快照（粉丝/获赞/作品数等）。
 * 若最新一条与本条完全相同，则只刷新时间戳，避免重复点堆积成平线噪音。
 * @param {string} secUserId
 * @param {{follower_count,following_count,total_favorited,aweme_count,favoriting_count,time?}} snap
 */
function pushAccountSnapshot(secUserId, snap) {
  if (!secUserId || !snap) return;
  const time = snap.time || Date.now();
  const fc = snap.follower_count || 0;
  const fgc = snap.following_count || 0;
  const tf = snap.total_favorited || 0;
  const ac = snap.aweme_count || 0;
  const fic = snap.favoriting_count || 0;

  db.run(`INSERT INTO account_history
    (sec_user_id, time, follower_count, following_count, total_favorited, aweme_count, favoriting_count)
    VALUES (?,?,?,?,?,?,?)`,
    [secUserId, time, fc, fgc, tf, ac, fic]);

  pruneAccountHistory(secUserId);
  scheduleFlush();
}

/**
 * 读取账号增速历史，按时间升序。上限 500 条（自动裁剪在写入时完成）。
 */
function listAccountHistory(secUserId) {
  if (!secUserId) return [];
  return all(`SELECT time, follower_count, following_count, total_favorited, aweme_count, favoriting_count
              FROM account_history WHERE sec_user_id=? ORDER BY time ASC`, [secUserId])
    .map(r => ({
      time: r.time,
      followerCount: r.follower_count,
      followingCount: r.following_count,
      totalFavorited: r.total_favorited,
      awemeCount: r.aweme_count,
      favoritingCount: r.favoriting_count,
    }));
}

/**
 * 超过 20000 条则删除最早的（保留最新 20000 条，约能存数月的数据量）。
 */
function pruneAccountHistory(secUserId) {
  db.run(`DELETE FROM account_history WHERE sec_user_id=? AND id NOT IN
          (SELECT id FROM account_history WHERE sec_user_id=? ORDER BY time DESC LIMIT 20000)`,
    [secUserId, secUserId]);
}

// ===== 账号下的作品清单 + 作品统计时序 =====

/**
 * 全量刷新某账号下的作品清单（用列表接口结果覆盖）。
 * 同时为每个作品追加一条统计时序点（去重同值）。
 * 兼容两种入参结构：
 *  - 已映射的扁平字段 {digg_count, comment_count, play_count, ...}
 *  - 接口原始 aweme {statistics:{digg_count,...}, video:{cover:{url_list:[...]}}}
 * @param {string} secUserId
 * @param {Array<{aweme_id,desc?,cover?,create_time?,digg_count,comment_count,play_count?,share_count?,collect_count?}>} works
 * @param {number} [time]
 */
function upsertAccountWorks(secUserId, works, time) {
  if (!secUserId || !Array.isArray(works)) return;
  const t = time || Date.now();
  // 先清掉旧关联（保留 work_stats_history 时序，只更新当前快照行）
  db.run('DELETE FROM account_works WHERE sec_user_id=?', [secUserId]);
  for (const w of works) {
    // 统计可能在顶层（已映射）或嵌套在 statistics（接口原始结构）中
    const st = w.statistics || {};
    const digg = w.digg_count ?? st.digg_count ?? 0;
    const comment = w.comment_count ?? st.comment_count ?? 0;
    const play = w.play_count ?? st.play_count ?? 0;
    const share = w.share_count ?? st.share_count ?? 0;
    const collect = w.collect_count ?? st.collect_count ?? 0;
    const cover = w.cover || (w.video && w.video.cover && w.video.cover.url_list && w.video.cover.url_list[0]) || '';
    db.run(`INSERT OR REPLACE INTO account_works
      (aweme_id, sec_user_id, desc_text, cover, create_time, digg_count, comment_count,
       play_count, share_count, collect_count, last_checked)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [w.aweme_id, secUserId, w.desc || '', cover, w.create_time || 0,
       digg, comment, play, share, collect, t]);
    // 追加作品统计时序点（去重：与最新一条相同则刷新时间）
    pushWorkStats(w.aweme_id,
      { diggCount: digg, commentCount: comment, playCount: play, shareCount: share, collectCount: collect },
      t, /*skipFlush*/ true);
  }
  scheduleFlush();
}

/**
 * 追加一条作品统计时序点。值未变时刷新时间戳。
 */
function pushWorkStats(awemeId, stats, time, skipFlush) {
  if (!awemeId || !stats) return;
  const t = time || Date.now();
  const digg = stats.diggCount || 0;
  const comment = stats.commentCount || 0;
  const play = stats.playCount || 0;
  const share = stats.shareCount || 0;
  const collect = stats.collectCount || 0;

  db.run(`INSERT INTO work_stats_history
    (aweme_id, time, digg_count, comment_count, play_count, share_count, collect_count)
    VALUES (?,?,?,?,?,?,?)`,
    [awemeId, t, digg, comment, play, share, collect]);

  // 限制单作品 20000 点
  db.run(`DELETE FROM work_stats_history WHERE aweme_id=? AND id NOT IN
          (SELECT id FROM work_stats_history WHERE aweme_id=? ORDER BY time DESC LIMIT 20000)`,
    [awemeId, awemeId]);
  if (!skipFlush) scheduleFlush();
}

/**
 * 读取账号下当前作品清单（最新快照值）。
 */
function listAccountWorks(secUserId) {
  if (!secUserId) return [];
  
  const now = Date.now();
  const timeDay = now - 24 * 3600 * 1000;
  const timeWeek = now - 7 * 24 * 3600 * 1000;
  const timeMonth = now - 30 * 24 * 3600 * 1000;

  const rows = all(`
    SELECT w.aweme_id, w.desc_text, w.cover, w.create_time, w.digg_count, w.comment_count,
           w.play_count, w.share_count, w.collect_count, w.last_checked,
           
           h_day.digg_count as day_digg, h_day.comment_count as day_comment, 
           h_day.share_count as day_share, h_day.collect_count as day_collect,
           h_day.play_count as day_play,
           
           h_week.digg_count as week_digg, h_week.comment_count as week_comment, 
           h_week.share_count as week_share, h_week.collect_count as week_collect,
           h_week.play_count as week_play,
           
           h_month.digg_count as month_digg, h_month.comment_count as month_comment, 
           h_month.share_count as month_share, h_month.collect_count as month_collect,
           h_month.play_count as month_play,
           
           h_total.digg_count as total_digg, h_total.comment_count as total_comment, 
           h_total.share_count as total_share, h_total.collect_count as total_collect,
           h_total.play_count as total_play
    FROM account_works w
    LEFT JOIN work_stats_history h_day ON h_day.id = COALESCE(
      (SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id AND time <= ? ORDER BY time DESC LIMIT 1),
      (SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id ORDER BY time ASC LIMIT 1)
    )
    LEFT JOIN work_stats_history h_week ON h_week.id = COALESCE(
      (SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id AND time <= ? ORDER BY time DESC LIMIT 1),
      (SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id ORDER BY time ASC LIMIT 1)
    )
    LEFT JOIN work_stats_history h_month ON h_month.id = COALESCE(
      (SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id AND time <= ? ORDER BY time DESC LIMIT 1),
      (SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id ORDER BY time ASC LIMIT 1)
    )
    LEFT JOIN work_stats_history h_total ON h_total.id = (
      SELECT id FROM work_stats_history WHERE aweme_id = w.aweme_id ORDER BY time ASC LIMIT 1
    )
    WHERE w.sec_user_id=?
    ORDER BY w.create_time DESC
  `, [timeDay, timeWeek, timeMonth, secUserId]);

  return rows.map(r => {
    const digg = r.digg_count || 0;
    const comment = r.comment_count || 0;
    const share = r.share_count || 0;
    const collect = r.collect_count || 0;
    const play = r.play_count || 0;

    const calcGrowth = (baseDigg, baseComment, baseShare, baseCollect, basePlay) => {
      const bDigg = baseDigg ?? digg;
      const bComment = baseComment ?? comment;
      const bShare = baseShare ?? share;
      const bCollect = baseCollect ?? collect;
      const bPlay = basePlay ?? play;

      const deltaDigg = digg - bDigg;
      const deltaComment = comment - bComment;
      const deltaShare = share - bShare;
      const deltaCollect = collect - bCollect;
      const deltaPlay = play - bPlay;

      const percentDigg = bDigg > 0 ? (deltaDigg / bDigg) * 100 : 0;
      const percentComment = bComment > 0 ? (deltaComment / bComment) * 100 : 0;
      const percentShare = bShare > 0 ? (deltaShare / bShare) * 100 : 0;
      const percentCollect = bCollect > 0 ? (deltaCollect / bCollect) * 100 : 0;
      const percentPlay = bPlay > 0 ? (deltaPlay / bPlay) * 100 : 0;

      return {
        diggDelta: deltaDigg,
        commentDelta: deltaComment,
        shareDelta: deltaShare,
        collectDelta: deltaCollect,
        playDelta: deltaPlay,
        diggPercent: percentDigg,
        commentPercent: percentComment,
        sharePercent: percentShare,
        collectPercent: percentCollect,
        playPercent: percentPlay
      };
    };

    const dayGrowth = calcGrowth(r.day_digg, r.day_comment, r.day_share, r.day_collect, r.day_play);
    const weekGrowth = calcGrowth(r.week_digg, r.week_comment, r.week_share, r.week_collect, r.week_play);
    const monthGrowth = calcGrowth(r.month_digg, r.month_comment, r.month_share, r.month_collect, r.month_play);
    const totalGrowth = calcGrowth(r.total_digg, r.total_comment, r.total_share, r.total_collect, r.total_play);

    return {
      awemeId: r.aweme_id,
      desc: r.desc_text,
      cover: r.cover,
      createTime: r.create_time,
      diggCount: digg,
      commentCount: comment,
      playCount: r.play_count || 0,
      shareCount: share,
      collectCount: collect,
      lastChecked: r.last_checked,
      
      // Multi-period growth metrics
      dayGrowth,
      weekGrowth,
      monthGrowth,
      totalGrowth,

      // Keep root delta/percent properties for backwards compatibility
      diggDelta: totalGrowth.diggDelta,
      commentDelta: totalGrowth.commentDelta,
      shareDelta: totalGrowth.shareDelta,
      collectDelta: totalGrowth.collectDelta,
      diggPercent: totalGrowth.diggPercent,
      commentPercent: totalGrowth.commentPercent,
      sharePercent: totalGrowth.sharePercent,
      collectPercent: totalGrowth.collectPercent
    };
  });
}

/**
 * 读取某作品的统计时序（点赞/评论/播放/分享随时间）。按时间升序。
 */
function listWorkStatsHistory(awemeId) {
  if (!awemeId) return [];
  return all(`SELECT time, digg_count, comment_count, play_count, share_count, collect_count
              FROM work_stats_history WHERE aweme_id=? ORDER BY time ASC`, [awemeId])
    .map(r => ({
      time: r.time,
      diggCount: r.digg_count,
      commentCount: r.comment_count,
      playCount: r.play_count,
      shareCount: r.share_count,
      collectCount: r.collect_count,
    }));
}

// ===== 下载任务 =====

function upsertDownloadTaskRaw(t) {
  let batchInfoStr = null;
  if (t.batchInfo) {
    try { batchInfoStr = typeof t.batchInfo === 'string' ? t.batchInfo : JSON.stringify(t.batchInfo); } catch (_) {}
  }
  const payload = buildTaskPayload(t);
  db.run(`INSERT INTO download_tasks
    (id, filename, url, save_path, video_info, status, progress, received_bytes,
     total_bytes, start_time, end_time, type, error, skipped, platform,
     batch_id, batch_info, custom_dir, payload_json, payload_version, revision, updated_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      filename=excluded.filename, url=excluded.url, save_path=excluded.save_path,
      video_info=excluded.video_info, status=excluded.status, progress=excluded.progress,
      received_bytes=excluded.received_bytes, total_bytes=excluded.total_bytes,
      start_time=excluded.start_time, end_time=excluded.end_time, type=excluded.type,
      error=excluded.error, skipped=excluded.skipped, platform=excluded.platform,
      batch_id=excluded.batch_id, batch_info=excluded.batch_info, custom_dir=excluded.custom_dir,
      payload_json=excluded.payload_json, payload_version=excluded.payload_version,
      revision=excluded.revision, updated_time=excluded.updated_time`,
    [t.id, t.filename || '', t.url || '', t.savePath || '',
     JSON.stringify(t.videoInfo || null), t.status || 'pending', t.progress || 0,
     t.receivedBytes || 0, t.totalBytes || 0, t.startTime || 0, t.endTime || 0,
     t.type || null, t.error || null, t.skipped ? 1 : 0,
     t.platform || (t.videoInfo && t.videoInfo.platform) || null,
     t.batchId || null, batchInfoStr, t.customDir || null,
     JSON.stringify(payload), payload.version,
     Number.isFinite(t.revision) ? t.revision : 0,
     Number.isFinite(t.updatedTime) ? t.updatedTime : 0]);
}

function listDownloadTasks() {
  return all(`SELECT * FROM download_tasks ORDER BY start_time DESC`).map(r => {
    let videoInfo = null;
    try { videoInfo = JSON.parse(r.video_info || 'null'); } catch (_) { /* ignore */ }
    let batchInfo = null;
    if (r.batch_info) {
      try { batchInfo = JSON.parse(r.batch_info || 'null'); } catch (_) { /* ignore */ }
    }
    let payload = null;
    if (r.payload_json) {
      try { payload = JSON.parse(r.payload_json); } catch (_) { /* ignore */ }
    }
    if (!payload || payload.version !== r.payload_version) payload = null;
    const task = {
      id: r.id, filename: r.filename, url: r.url, savePath: r.save_path,
      videoInfo, status: r.status, progress: r.progress,
      receivedBytes: r.received_bytes, totalBytes: r.total_bytes,
      startTime: r.start_time, endTime: r.end_time,
      type: r.type, error: r.error, skipped: !!r.skipped,
      // 平台名称：优先用独立列，旧任务回退到 video_info.platform
      platform: r.platform || (videoInfo && videoInfo.platform) || '',
      batchId: r.batch_id || undefined,
      batchInfo: batchInfo || undefined,
      customDir: r.custom_dir || undefined,
      revision: Number.isFinite(r.revision) ? r.revision : 0,
      updatedTime: Number.isFinite(r.updated_time) ? r.updated_time : 0,
    };
    return applyTaskPayload(task, payload);
  });
}

function saveDownloadTask(task) {
  upsertDownloadTaskRaw(task);
  scheduleFlush();
}

function saveDownloadTasks(tasks) {
  if (!Array.isArray(tasks)) return;
  db.run('BEGIN');
  try {
    for (const t of tasks) upsertDownloadTaskRaw(t);
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) { /* preserve the original error */ }
    throw error;
  }
  scheduleFlush();
}

function deleteDownloadTask(taskId) {
  db.run('DELETE FROM download_tasks WHERE id=?', [taskId]);
  scheduleFlush();
}

// ===== 主页下载历史记录 =====
// 按 sec_user_id 去重（INSERT OR REPLACE 覆盖）；videos 存完整 aweme 数组的 JSON 字符串

function listProfileHistory() {
  return all(`SELECT * FROM profile_history ORDER BY updated_time DESC`).map(r => {
    let videos = [];
    try { videos = JSON.parse(r.videos || '[]') || []; } catch (_) { /* ignore */ }
    return {
      sec_user_id: r.sec_user_id,
      nickname: r.nickname || '',
      avatar: r.avatar || '',
      unique_id: r.unique_id || '',
      videos,
      video_count: r.video_count || 0,
      download_type: r.download_type || 'post',
      source_url: r.source_url || '',
      platform: r.platform || 'douyin',
      created_time: r.created_time || 0,
      updated_time: r.updated_time || 0,
    };
  });
}

// h: { secUserId, nickname, avatar, uniqueId, videos, videoCount, downloadType, sourceUrl, platform }
// 首次插入记 created_time，重新抓取覆盖时更新 updated_time 并保留 created_time
function upsertProfileHistory(h) {
  const key = h.secUserId;
  const existing = get(`SELECT created_time FROM profile_history WHERE sec_user_id=?`, [key]);
  const now = Date.now();
  const createdTime = existing ? existing.created_time : now;
  db.run(`INSERT OR REPLACE INTO profile_history
    (sec_user_id, nickname, avatar, unique_id, videos, video_count,
     download_type, source_url, platform, created_time, updated_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [key, h.nickname || '', h.avatar || '', h.uniqueId || '',
     JSON.stringify(h.videos || []), h.videoCount || 0,
     h.downloadType || 'post', h.sourceUrl || '', h.platform || 'douyin',
     createdTime, now]);
  flushNow();
}

function removeProfileHistory(key) {
  db.run('DELETE FROM profile_history WHERE sec_user_id=?', [key]);
  flushNow();
}

function clearProfileHistory() {
  db.run('DELETE FROM profile_history');
  flushNow();
}

// ===== KV（settings / control_panel_url / cookie_douyin / 等） =====

function getRawKV(key, fallback) {
  const r = get(`SELECT value FROM kv WHERE key=?`, [key]);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch (_) { return fallback; }
}

function setRawKV(key, value) {
  db.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)', [key, JSON.stringify(value)]);
  markDirty();
}

function deleteRawKV(key) {
  db.run('DELETE FROM kv WHERE key=?', [key]);
  markDirty();
  return true;
}

function listKVKeys(prefix = '') {
  const normalizedPrefix = String(prefix || '');
  return all('SELECT key FROM kv WHERE key LIKE ? ORDER BY key', [`${normalizedPrefix}%`])
    .map(row => row.key);
}

function getKV(key, fallback) {
  if (isSecretKVKey(key)) {
    if (!configuredSecretStore) return fallback;
    return configuredSecretStore.get(key, fallback);
  }
  return getRawKV(key, fallback);
}

function setKV(key, value) {
  if (isSecretKVKey(key)) {
    if (!configuredSecretStore) {
      const error = new Error('Windows 凭据加密尚未初始化');
      error.code = 'SECURE_STORAGE_UNAVAILABLE';
      throw error;
    }
    configuredSecretStore.set(key, value);
    return;
  }
  setRawKV(key, value);
}

function deleteKV(key) {
  if (isSecretKVKey(key) && configuredSecretStore) {
    return configuredSecretStore.delete(key);
  }
  return deleteRawKV(key);
}

// ===== 工具：查询助手 =====

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = [];
  while (stmt.step()) {
    result.push(stmt.getAsObject());
  }
  stmt.free();
  return result;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

module.exports = {
  initDatabase,
  configureSecretStore,
  flushNow,
  flushBeforeQuit,
  getPersistenceState,
  // 监控用户
  listMonitorUsers,
  addMonitorUser,
  removeMonitorUser,
  updateMonitorUser,
  updateMonitorUserSnapshot,
  updateMonitorUserMeta,
  persistMonitorState,
  getMonitorUser,
  moveMonitorUserToGroup,
  // 监控视频
  listMonitorVideos,
  addMonitorVideo,
  removeMonitorVideo,
  updateMonitorVideoSnapshot,
  updateMonitorVideoMeta,
  moveMonitorVideoToGroup,
  // 事件
  addMonitorEvent,
  listMonitorEvents,
  clearMonitorEvents,
  markMonitorEventsRead,
  // 配置
  getMonitorConfig,
  setMonitorConfig,
  // 账号
  listAccounts,
  addAccount,
  removeAccount,
  updateAccountMeta,
  updateAccount: updateAccountMeta,
  // 我的账号（运营专区：多账号绑定）
  listMyAccounts,
  addMyAccount,
  removeMyAccount,
  getMyAccountSecret,
  setMyAccountSecret,
  migrateMyAccountSecrets,
  clearMyAccountSecrets,
  // 分组（account / monitor_user / monitor_video 共用）
  listGroups,
  addGroup,
  renameGroup,
  removeGroup,
  updateGroupColor,
  moveAccountToGroup,
  // 账号增速历史
  pushAccountSnapshot,
  listAccountHistory,
  pruneAccountHistory,
  // 账号作品 + 作品时序
  upsertAccountWorks,
  pushWorkStats,
  listAccountWorks,
  listWorkStatsHistory,
  // 下载任务
  listDownloadTasks,
  saveDownloadTask,
  saveDownloadTasks,
  deleteDownloadTask,
  // 主页下载历史记录
  listProfileHistory,
  upsertProfileHistory,
  removeProfileHistory,
  clearProfileHistory,
  // KV
  getKV,
  setKV,
  deleteKV,
  getRawKV,
  setRawKV,
  deleteRawKV,
  listKVKeys,
};
