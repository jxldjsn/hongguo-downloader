'use strict';

require('../_test_login_window_navigation.js');
require('../_test_single_instance_lock.js');
require('./task-state.test.js');
require('./task-payload.test.js');
require('./database-download-tasks.test.js');
require('./scheduler.test.js');
require('./file-output.test.js');
require('./special-download-results.test.js');
require('./hongguo-worker.test.js');
require('./process-runner.test.js');
require('./manifest-download.test.js');
require('./ipc-guards.test.js');
require('./security-integration.test.js');
require('./secret-store.test.js');
require('./cookie-files.test.js');
require('./main-integration.test.js');
require('./renderer-integration.test.js');
require('./package-config.test.js');
require('./dependency-contract.test.js');
require('./ipc-contract.test.js');
require('./auth-status.test.js');
require('./login-probes.test.js');
require('./login-status-polling.test.js');
require('./titlebar-integration.test.js');
require('./douyin-diagnostic.test.js');

const test = require('node:test');
test('download UI helper semantics', async t => {
  const { runDownloadUiTests } = await import('./download-ui.test.mjs');
  await runDownloadUiTests(t);
});
