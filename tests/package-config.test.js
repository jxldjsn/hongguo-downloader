'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SUPPORTED_PE_MACHINES,
  readPeMachine,
  getDevelopmentToolPaths,
} = require('../build/verify-win64-tools');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

test('package configuration supports only reproducible Windows x64 output', () => {
  assert.deepEqual(packageJson.build.win.target, [
    { target: 'nsis', arch: ['x64'] },
  ]);
  assert.equal(packageJson.build.directories.output, 'release');
  assert.equal(path.isAbsolute(packageJson.build.directories.output), false);
  assert.equal(packageJson.build.mac, undefined);
  assert.equal(packageJson.scripts['build:mac'], undefined);
  assert.equal(packageJson.build.asar, true);
  assert.equal(packageJson.scripts['prepack:win64'], 'node build/verify-win64-tools.js');
  assert.equal(
    packageJson.scripts['build:win'],
    'npm run check && npm run prepack:win64 && node --experimental-require-module ./node_modules/electron-builder/cli.js --win --x64',
  );
});

test('every bundled executable is a Windows PE image', () => {
  const executables = getDevelopmentToolPaths(projectRoot);

  for (const [name, filePath] of Object.entries(executables)) {
    assert.equal(fs.existsSync(filePath), true, `${name} executable is missing: ${filePath}`);
    assert.equal(SUPPORTED_PE_MACHINES.has(readPeMachine(filePath)), true, `${name} must be a valid Windows PE image`);
  }
});

test('afterPack resolves the resource directory through electron-builder', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'build', 'afterPack.js'), 'utf8');
  assert.match(source, /context\.packager\.getResourcesDir\(context\.appOutDir\)/);
  assert.match(source, /electronPlatformName\s*!==\s*['"]win32['"]/);
  assert.doesNotMatch(source, /path\.join\(appOutDir,\s*['"]resources['"]\)/);
});

test('startup documentation describes the active Electron Windows x64 application only', () => {
  const documentNames = ['README.md', 'QUICK_START.md', '启动说明.md'];
  for (const documentName of documentNames) {
    const source = fs.readFileSync(path.join(projectRoot, documentName), 'utf8');
    assert.match(source, /Windows 10\/11 x64/);
    assert.match(source, /Electron[^\n]*Node|Node[^\n]*Electron/);
    assert.match(source, /release\//);
    assert.match(source, /抖音下载器源码\//);
    assert.doesNotMatch(
      source,
      /pyinstaller|pip install|python-backend|pythonAPI|checkPythonStatus|127\.0\.0\.1:5555|build:mac/i,
    );
  }
});
