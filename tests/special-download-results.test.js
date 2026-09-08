'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeItems,
  escapeSpreadsheetCSVCell,
  parseYtdlpOutputLine,
} = require('../src/native/download/specialDownloadResults');

test('summarizeItems reports partial results and counts only successful items as progress', () => {
  const summary = summarizeItems([
    { index: 0, url: 'https://media.example/1.jpg', ok: true },
    { index: 1, url: 'https://media.example/2.jpg', ok: false, error: 'HTTP 403' },
  ]);

  assert.deepEqual(summary, {
    status: 'partial',
    succeeded: 1,
    failed: 1,
    failures: [
      { index: 1, url: 'https://media.example/2.jpg', ok: false, error: 'HTTP 403' },
    ],
  });
});

test('summarizeItems completes only when every required item succeeds', () => {
  assert.deepEqual(summarizeItems([
    { index: 0, ok: true },
    { index: 1, ok: true },
  ]), {
    status: 'completed',
    succeeded: 2,
    failed: 0,
    failures: [],
  });

  assert.equal(summarizeItems([{ index: 0, ok: false, error: 'bad' }]).status, 'partial');
});

test('CSV cells neutralize spreadsheet formulas before normal quoting', () => {
  assert.equal(escapeSpreadsheetCSVCell('=1+1'), "'=1+1");
  assert.equal(escapeSpreadsheetCSVCell('+cmd|calc'), "'+cmd|calc");
  assert.equal(escapeSpreadsheetCSVCell('-2+3'), "'-2+3");
  assert.equal(escapeSpreadsheetCSVCell('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(escapeSpreadsheetCSVCell('normal,cell'), '"normal,cell"');
  assert.equal(escapeSpreadsheetCSVCell('"quoted"'), '"""quoted"""');
});

test('yt-dlp output parsing accepts only the explicit after-move marker', () => {
  assert.equal(
    parseYtdlpOutputLine('__APP_OUTPUT__C:\\Downloads\\video.mp4'),
    'C:\\Downloads\\video.mp4',
  );
  assert.equal(parseYtdlpOutputLine('[download] Destination: stale.mp4'), null);
  assert.equal(parseYtdlpOutputLine('__APP_OUTPUT__'), null);
});

