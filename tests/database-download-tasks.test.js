'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const { FIELDS_BY_TYPE, buildTaskPayload, validateTaskPayload } = require('../src/native/download/taskPayload');
const { createSecretStore } = require('../src/native/security/secretStore');

let sqlPromise;

function getSql() {
  if (!sqlPromise) {
    const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
    sqlPromise = initSqlJs({ locateFile: () => wasmPath });
  }
  return sqlPromise;
}

function freshDatabaseModule() {
  const modulePath = require.resolve('../src/native/database');
  delete require.cache[modulePath];
  return require(modulePath);
}

function createStoreStub(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    set(key, value) {
      values.set(key, value);
    },
  };
}

function createTempUserData(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-download-db-'));
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(userData);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, userData, app: { getPath: () => userData } };
}

function configureTestSecretStore(database) {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8').slice(4),
  };
  database.configureSecretStore(createSecretStore({
    safeStorage,
    getRaw: key => database.getRawKV(key, undefined),
    setRaw: (key, value) => database.setRawKV(key, value),
    deleteRaw: key => database.deleteRawKV(key),
  }));
}

async function openDiskDatabase(userData) {
  const SQL = await getSql();
  return new SQL.Database(fs.readFileSync(path.join(userData, 'app.db')));
}

function allRows(database, sql, params = []) {
  const statement = database.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function specialTasks() {
  const details = {
    album: {
      albumItems: [{ type: 'image', url: 'https://media.example/album.jpg', meta: { index: 1 } }],
      albumFolderName: 'album-folder',
      headers: { Referer: 'https://album.example/' },
    },
    dash: {
      dashVideoUrl: 'https://media.example/video.m4s',
      dashAudioUrl: 'https://media.example/audio.m4s',
      headers: { Referer: 'https://dash.example/' },
    },
    m3u8: {
      m3u8Url: 'https://media.example/master.m3u8',
      headers: { Referer: 'https://m3u8.example/' },
    },
    mpd: {
      mpdUrl: 'https://media.example/manifest.mpd',
      headers: { Referer: 'https://mpd.example/' },
    },
    ytdl: {
      ytdlUrl: 'https://video.example/watch?v=fixture',
      ytdlMaxHeight: 720,
    },
    hongguo: {
      hongguoInfo: { vid: 'hongguo-fixture', episode: 8, nested: { quality: 'hd' } },
      headers: { Referer: 'https://hongguo.example/' },
    },
  };

  return Object.entries(details).map(([type, data], index) => ({
    id: `task-${type}`,
    filename: `${type}.mp4`,
    url: `https://common.example/${type}`,
    savePath: `C:/fixture/${type}.mp4`,
    videoInfo: { title: `${type} title`, platform: 'fixture' },
    status: 'failed',
    progress: index,
    receivedBytes: index * 10,
    totalBytes: 1000,
    startTime: 10000 + index,
    endTime: 20000 + index,
    type,
    platform: 'fixture',
    batchId: 'batch-fixture',
    batchInfo: { index, nested: { value: type } },
    customDir: `C:/fixture/${type}`,
    revision: index + 2,
    updatedTime: 30000 + index,
    runtime: { secret: type, close() {} },
    cancelSource: { cancel() {} },
    writer: { end() {} },
    responseStream: { destroy() {} },
    childProcess: { kill() {} },
    ytdlProcess: { kill() {} },
    ...data,
  }));
}

test('flushNow explicitly fails before database initialization', () => {
  const database = freshDatabaseModule();
  assert.throws(
    () => database.flushNow(),
    error => error && error.code === 'PERSIST_FAILED' && /初始化|保存/.test(error.message),
  );
});

test('my-account DTOs omit credentials and account secrets are encrypted outside the account row', async t => {
  const { userData, app } = createTempUserData(t);
  const database = freshDatabaseModule();
  configureTestSecretStore(database);
  await database.initDatabase(app, createStoreStub());

  database.addMyAccount({
    uid: '10001',
    sec_uid: 'sec-10001',
    nickname: 'fixture',
    cookie: 'sessionid=must-not-enter-account-row',
  });
  database.setMyAccountSecret('10001', 'sessionid=encrypted-secret');

  const [account] = database.listMyAccounts();
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'cookie'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'cookieString'), false);
  assert.equal(database.getMyAccountSecret('10001'), 'sessionid=encrypted-secret');
  assert.doesNotMatch(JSON.stringify(database.getRawKV('cookie_my_account_10001')), /encrypted-secret/);

  database.flushNow();
  const diskDatabase = await openDiskDatabase(userData);
  const [storedAccount] = allRows(diskDatabase, 'SELECT cookie FROM my_accounts WHERE uid=?', ['10001']);
  assert.equal(storedAccount.cookie, '');
  const [storedSecret] = allRows(diskDatabase, 'SELECT value FROM kv WHERE key=?', ['cookie_my_account_10001']);
  assert.doesNotMatch(storedSecret.value, /encrypted-secret/);
  diskDatabase.close();
});

test('legacy my-account plaintext is encrypted and erased during startup migration', async t => {
  const { userData, app } = createTempUserData(t);
  const SQL = await getSql();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE my_accounts (
    uid TEXT PRIMARY KEY, sec_uid TEXT, nickname TEXT, avatar TEXT,
    cookie TEXT, added_time INTEGER
  )`);
  legacy.run('INSERT INTO my_accounts (uid, sec_uid, nickname, avatar, cookie, added_time) VALUES (?,?,?,?,?,?)', [
    'legacy-uid', 'legacy-sec', 'legacy', '', 'sessionid=legacy-account-secret', Date.now(),
  ]);
  fs.writeFileSync(path.join(userData, 'app.db'), Buffer.from(legacy.export()));
  legacy.close();

  const database = freshDatabaseModule();
  configureTestSecretStore(database);
  await database.initDatabase(app, createStoreStub());

  assert.equal(database.getMyAccountSecret('legacy-uid'), 'sessionid=legacy-account-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(database.listMyAccounts()[0], 'cookie'), false);
  database.flushNow();

  const migrated = await openDiskDatabase(userData);
  assert.equal(allRows(migrated, 'SELECT cookie FROM my_accounts WHERE uid=?', ['legacy-uid'])[0].cookie, '');
  const encryptedValue = allRows(migrated, 'SELECT value FROM kv WHERE key=?', ['cookie_my_account_legacy-uid'])[0].value;
  assert.doesNotMatch(encryptedValue, /legacy-account-secret/);
  migrated.close();
});

test('download task UPSERT persists all special payloads across restart without deleting other rows', async t => {
  const { userData, app } = createTempUserData(t);
  const store = createStoreStub();
  let database = freshDatabaseModule();
  await database.initDatabase(app, store);

  const tasks = [
    ...specialTasks(),
    {
      id: 'task-file',
      filename: 'plain.mp4',
      url: 'https://media.example/plain.mp4',
      savePath: 'C:/fixture/plain.mp4',
      videoInfo: { title: 'plain title', platform: 'fixture' },
      status: 'failed',
      progress: 12,
      receivedBytes: 120,
      totalBytes: 1000,
      startTime: 11000,
      endTime: 21000,
      platform: 'fixture',
      headers: { Referer: 'https://plain.example/', Authorization: 'fixture-token' },
      revision: 12,
      updatedTime: 31000,
    },
  ];
  const independentlySaved = tasks[1];
  database.saveDownloadTask(independentlySaved);
  assert.equal(database.flushNow(), true);

  database.saveDownloadTasks(tasks.filter(task => task.id !== independentlySaved.id));
  assert.equal(database.flushNow(), true);
  assert.equal(database.listDownloadTasks().length, tasks.length, 'batch save must preserve independent rows');

  database = freshDatabaseModule();
  await database.initDatabase(app, store);
  const restored = database.listDownloadTasks();
  assert.equal(restored.length, tasks.length);
  const restoredById = new Map(restored.map(task => [task.id, task]));

  for (const original of tasks) {
    const actual = restoredById.get(original.id);
    assert.ok(actual, original.id);
    assert.equal(actual.revision, original.revision);
    assert.equal(actual.updatedTime, original.updatedTime);
    assert.deepEqual(actual.videoInfo, original.videoInfo);
    assert.deepEqual(actual.batchInfo, original.batchInfo);
    const payloadType = original.type || 'file';
    for (const field of FIELDS_BY_TYPE[payloadType]) {
      assert.deepEqual(actual[field], original[field], `${payloadType}.${field}`);
    }
    for (const runtimeField of [
      'runtime', 'cancelSource', 'writer', 'responseStream', 'childProcess', 'ytdlProcess',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(actual, runtimeField), false, runtimeField);
    }
    assert.deepEqual(validateTaskPayload(buildTaskPayload(actual)), { valid: true });
  }

  const diskDatabase = await openDiskDatabase(userData);
  const columns = new Map(allRows(diskDatabase, 'PRAGMA table_info(download_tasks)')
    .map(column => [column.name, column]));
  for (const name of [
    'platform', 'batch_id', 'batch_info', 'custom_dir',
    'payload_json', 'payload_version', 'revision', 'updated_time',
  ]) {
    assert.ok(columns.has(name), `missing download_tasks.${name}`);
  }
  assert.equal(columns.get('payload_version').dflt_value, '1');
  assert.equal(columns.get('revision').dflt_value, '0');
  assert.equal(columns.get('updated_time').dflt_value, '0');
  diskDatabase.close();

  database.deleteDownloadTask(independentlySaved.id);
  assert.equal(database.flushNow(), true);
  database = freshDatabaseModule();
  await database.initDatabase(app, store);
  assert.equal(database.listDownloadTasks().some(task => task.id === independentlySaved.id), false);
});

test('download_tasks migration is idempotent and leaves old common task data readable', async t => {
  const { userData, app } = createTempUserData(t);
  const SQL = await getSql();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE download_tasks (
    id TEXT PRIMARY KEY, filename TEXT, url TEXT, save_path TEXT,
    video_info TEXT, status TEXT, progress INTEGER,
    received_bytes INTEGER, total_bytes INTEGER,
    start_time INTEGER, end_time INTEGER, type TEXT, error TEXT, skipped INTEGER,
    platform TEXT, batch_id TEXT, batch_info TEXT, custom_dir TEXT
  )`);
  legacy.run(`INSERT INTO download_tasks
    (id, filename, url, save_path, video_info, status, progress, received_bytes,
     total_bytes, start_time, end_time, type, error, skipped, platform,
     batch_id, batch_info, custom_dir)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'legacy-video', 'legacy.mp4', 'https://legacy.example/video', 'C:/legacy.mp4',
    JSON.stringify({ title: 'legacy', platform: 'legacy-platform' }), 'failed', 25,
    10, 40, 100, 200, 'video', 'legacy error', 0, 'legacy-platform',
    'legacy-batch', JSON.stringify({ source: 'legacy' }), 'C:/legacy',
  ]);
  fs.writeFileSync(path.join(userData, 'app.db'), Buffer.from(legacy.export()));
  legacy.close();

  let database = freshDatabaseModule();
  await database.initDatabase(app, createStoreStub());
  assert.equal(database.flushNow(), true);
  database = freshDatabaseModule();
  await database.initDatabase(app, createStoreStub());
  assert.equal(database.flushNow(), true);

  const [task] = database.listDownloadTasks();
  assert.equal(task.id, 'legacy-video');
  assert.equal(task.filename, 'legacy.mp4');
  assert.equal(task.platform, 'legacy-platform');
  assert.equal(task.revision, 0);
  assert.equal(task.updatedTime, 0);

  const migrated = await openDiskDatabase(userData);
  const columnNames = allRows(migrated, 'PRAGMA table_info(download_tasks)').map(column => column.name);
  for (const name of ['payload_json', 'payload_version', 'revision', 'updated_time']) {
    assert.equal(columnNames.filter(column => column === name).length, 1, `${name} migration must be idempotent`);
  }
  migrated.close();
});

test('malformed payload JSON or version cannot break the task list and remains invalid for retry', async t => {
  const { userData, app } = createTempUserData(t);
  let database = freshDatabaseModule();
  await database.initDatabase(app, createStoreStub());
  database.saveDownloadTasks([
    { id: 'bad-json', filename: 'one', status: 'failed', type: 'album', albumItems: [{ url: 'one' }] },
    { id: 'bad-version', filename: 'two', status: 'failed', type: 'm3u8', m3u8Url: 'manifest' },
  ]);
  assert.equal(database.flushNow(), true);

  const diskDatabase = await openDiskDatabase(userData);
  diskDatabase.run('UPDATE download_tasks SET payload_json=? WHERE id=?', ['{bad-json', 'bad-json']);
  diskDatabase.run('UPDATE download_tasks SET payload_json=?, payload_version=? WHERE id=?', [
    JSON.stringify({ version: 99, type: 'm3u8', data: { m3u8Url: 'manifest' } }),
    99,
    'bad-version',
  ]);
  fs.writeFileSync(path.join(userData, 'app.db'), Buffer.from(diskDatabase.export()));
  diskDatabase.close();

  database = freshDatabaseModule();
  await database.initDatabase(app, createStoreStub());
  const listed = database.listDownloadTasks();
  assert.equal(listed.length, 2);
  for (const task of listed) {
    assert.ok(task.id === 'bad-json' || task.id === 'bad-version');
    assert.equal(task.status, 'failed');
    assert.equal(typeof task.filename, 'string');
    const validation = validateTaskPayload(buildTaskPayload(task));
    assert.equal(validation.valid, false, task.id);
  }
});

test('saveDownloadTasks rolls back all row changes when one UPSERT fails', async t => {
  const { app } = createTempUserData(t);
  const database = freshDatabaseModule();
  await database.initDatabase(app, createStoreStub());
  database.saveDownloadTask({ id: 'stable', filename: 'before.mp4', type: 'video', status: 'failed' });
  assert.equal(database.flushNow(), true);

  const circularVideoInfo = { title: 'circular' };
  circularVideoInfo.self = circularVideoInfo;
  assert.throws(() => database.saveDownloadTasks([
    { id: 'stable', filename: 'after.mp4', type: 'video', status: 'failed' },
    { id: 'must-not-exist', filename: 'bad.mp4', type: 'video', videoInfo: circularVideoInfo },
  ]));

  const tasks = database.listDownloadTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'stable');
  assert.equal(tasks[0].filename, 'before.mp4');
});

test('flush failures stay dirty, are sanitized, do not escape timers, and can recover', async t => {
  const { root, userData, app } = createTempUserData(t);
  const database = freshDatabaseModule();
  await database.initDatabase(app, createStoreStub());
  database.setKV('fixture', 'initial');
  assert.equal(database.flushNow(), true);

  const movedUserData = path.join(root, 'user-data-moved');
  fs.renameSync(userData, movedUserData);
  fs.writeFileSync(userData, 'blocks-child-paths');

  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { logCalls.push(args.map(String).join(' ')); };
  try {
    database.setKV('fixture', 'manual-failure');
    assert.throws(
      () => database.flushNow(),
      error => error
        && error.code === 'PERSIST_FAILED'
        && error.cause
        && error.systemCode === error.cause.code,
    );
    assert.equal(database.getPersistenceState().dirty, true);
    assert.equal(database.getPersistenceState().timer, false);
    assert.equal(logCalls.length, 1);
    assert.equal(logCalls[0].includes(root), false, 'flush log must not expose the database path');

    logCalls.length = 0;
    database.saveDownloadTask({ id: 'timer-failure', filename: 'timer.mp4', type: 'video' });
    assert.equal(database.getPersistenceState().timer, true);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(database.getPersistenceState().dirty, true);
    assert.equal(database.getPersistenceState().timer, false);
    assert.equal(logCalls.length, 1, 'one scheduled failure must produce one sanitized log');
    assert.equal(logCalls[0].includes(root), false);
  } finally {
    console.error = originalConsoleError;
    fs.rmSync(userData, { force: true });
    fs.renameSync(movedUserData, userData);
  }

  assert.equal(database.flushNow(), true);
  assert.deepEqual(database.getPersistenceState(), {
    dirty: false,
    timer: false,
    flushScheduled: false,
  });
});
