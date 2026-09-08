'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

function installedVersion(name) {
  return packageLock.packages[`node_modules/${name}`]?.version;
}

test('security dependency contract pins the reviewed package set', () => {
  assert.equal(packageJson.engines.node, '>=22.12.0');
  assert.equal(packageJson.dependencies.xlsx, undefined);
  assert.equal(packageLock.packages['node_modules/xlsx'], undefined);
  assert.equal(packageJson.dependencies.exceljs, '^4.4.0');

  assert.equal(installedVersion('axios'), '1.18.0');
  assert.equal(installedVersion('sm-crypto'), '0.5.5');
  assert.equal(installedVersion('exceljs'), '4.4.0');
  assert.equal(installedVersion('vite'), '6.4.3');
  assert.equal(installedVersion('@vitejs/plugin-react'), '5.0.4');
  assert.equal(installedVersion('electron-builder'), '26.15.3');
  assert.equal(installedVersion('electron'), '41.10.4');
  assert.equal(installedVersion('sharp'), '0.35.3');
  assert.equal(packageJson.overrides.uuid, '11.1.1');
  assert.equal(installedVersion('uuid'), '11.1.1');
});

test('the upgraded SM3 implementation preserves the standard abc digest', () => {
  const { sm3 } = require('sm-crypto');
  const { ABogus } = require('../src/native/encrypt/aBogus');
  const expected = '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0';
  assert.equal(
    sm3('abc'),
    expected,
  );
  assert.deepEqual(ABogus.sm3ToArray('abc'), [...Buffer.from(expected, 'hex')]);
});

test('Excel export is a ZIP workbook and dangerous formulas remain text', async () => {
  const ExcelJS = require('exceljs');
  const { buildWorkbookBuffer } = await import('../src/utils/xlsxWorkbook.mjs');
  const dangerousText = ' \t=HYPERLINK("https://example.invalid")';
  const buffer = await buildWorkbookBuffer([
    { text: dangerousText, count: 42, publishedAt: new Date('2026-08-11T00:00:00.000Z') },
  ], {
    sheetName: 'Contract',
    columns: [
      { header: 'Text', key: 'text', width: 30 },
      { header: 'Count', key: 'count', width: 10 },
      { header: 'Published', key: 'publishedAt', width: 20 },
    ],
  });

  const bytes = Buffer.from(buffer);
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const worksheet = workbook.getWorksheet('Contract');
  assert.equal(worksheet.getCell('A2').value, `'${dangerousText}`);
  assert.equal(worksheet.getCell('B2').value, 42);
  assert.ok(worksheet.getCell('C2').value instanceof Date);
});

test('all renderer Excel actions await asynchronous workbook creation', () => {
  const components = ['AccountManager.jsx', 'MyAccounts.jsx', 'ProfileDownload.jsx'];
  for (const component of components) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', component), 'utf8');
    assert.match(source, /await\s+exportVideosToXlsx\(/, `${component} must await export`);
  }
});

test('Vite configuration is native ESM for the ESM-only React plugin', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'vite.config.js')), false);
  const source = fs.readFileSync(path.join(__dirname, '..', 'vite.config.mjs'), 'utf8');
  assert.match(source, /import\s+react\s+from\s+['"]@vitejs\/plugin-react['"]/);
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/);
});
