import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  successfulIndices,
  aggregateBatch,
  dispatchResource,
  mergeTaskEvent,
  resourceAction,
  upsertResource,
} from '../src/utils/downloadUi.mjs';

export async function runDownloadUiTests(t) {
  await t.test('successfulIndices selects only accepted parse results', () => {
    assert.deepEqual(
      successfulIndices([{ success: false }, { success: true }, {}, { success: true }]),
      new Set([1, 3]),
    );
  });

  await t.test('aggregateBatch preserves active, partial, failed, stopped, and completed semantics', () => {
    assert.equal(aggregateBatch([{ status: 'completed' }, { status: 'failed' }]), 'partial');
    assert.equal(aggregateBatch([{ status: 'stopped' }]), 'stopped');
    assert.equal(aggregateBatch([{ status: 'failed' }, { status: 'failed' }]), 'failed');
    assert.equal(aggregateBatch([{ status: 'completed' }, { status: 'completed' }]), 'completed');
    assert.equal(aggregateBatch([{ status: 'completed' }, { status: 'downloading' }]), 'downloading');
    assert.equal(aggregateBatch([{ status: 'parsing' }]), 'parsing');
    assert.equal(aggregateBatch([{ status: 'partial' }, { status: 'completed' }]), 'partial');
  });

  await t.test('mergeTaskEvent rejects stale revisions and appends new task ids', () => {
    const current = [{ id: 'a', revision: 2, progress: 50, status: 'downloading' }];
    assert.deepEqual(
      mergeTaskEvent(current, { id: 'a', revision: 1, progress: 10 }),
      current,
    );
    assert.deepEqual(
      mergeTaskEvent(current, { id: 'a', revision: 3, progress: 100, status: 'completed' }),
      [{ id: 'a', revision: 3, progress: 100, status: 'completed' }],
    );
    assert.deepEqual(
      mergeTaskEvent(current, { id: 'b', revision: 0, progress: 0 }),
      [...current, { id: 'b', revision: 0, progress: 0 }],
    );
  });

  await t.test('mergeTaskEvent accepts revision-less progress without reopening terminal tasks', () => {
    assert.deepEqual(
      mergeTaskEvent(
        [{ id: 'a', revision: 2, progress: 50, status: 'downloading' }],
        { id: 'a', progress: 60, status: 'downloading' },
      ),
      [{ id: 'a', revision: 2, progress: 60, status: 'downloading' }],
    );
    const completed = [{ id: 'a', revision: 3, progress: 100, status: 'completed' }];
    assert.deepEqual(
      mergeTaskEvent(completed, { id: 'a', progress: 90, status: 'downloading' }),
      completed,
    );
  });

  await t.test('upsertResource keeps the most specific resource for a URL', () => {
    assert.deepEqual(
      upsertResource([{ url: 'u', type: 'm3u8_seg' }], { url: 'u', type: 'video_dash' }),
      [{ url: 'u', type: 'video_dash' }],
    );
    assert.deepEqual(
      upsertResource([{ url: 'u', type: 'dash', keep: true }], { url: 'u', type: 'video' }),
      [{ url: 'u', type: 'dash', keep: true }],
    );
    assert.deepEqual(
      upsertResource([{ url: 'u1', type: 'video' }], { url: 'u2', type: 'image' }),
      [{ url: 'u1', type: 'video' }, { url: 'u2', type: 'image' }],
    );
  });

  await t.test('resourceAction maps every sniffed and live resource type', () => {
    assert.equal(resourceAction({ type: 'm3u8' }), 'downloadM3u8');
    assert.equal(resourceAction({ type: 'dash' }), 'downloadMpd');
    for (const type of ['video_dash', 'audio_dash', 'm3u8_seg', 'video', 'image', 'audio']) {
      assert.equal(resourceAction({ type }), 'downloadFile');
    }
    assert.equal(resourceAction({ type: 'rtmp' }), 'recordWithFfmpeg');
    assert.throws(() => resourceAction({ type: 'unknown' }), /不支持/);
  });

  await t.test('dispatchResource shares IPC routing and treats explicit rejection as failure', async () => {
    const calls = [];
    const electronAPI = {
      downloadM3u8: async (...args) => { calls.push(['downloadM3u8', ...args]); return { success: true }; },
      downloadMpd: async (...args) => { calls.push(['downloadMpd', ...args]); return { success: true }; },
      downloadFile: async (...args) => { calls.push(['downloadFile', ...args]); return { success: true }; },
      recordLiveStream: async (...args) => { calls.push(['recordLiveStream', ...args]); return { success: false, error: '拒绝' }; },
    };
    await dispatchResource({ type: 'm3u8', url: 'https://example.test/a.m3u8' }, electronAPI, {
      filename: 'a.mp4', videoInfo: { title: 'a' }, platform: 'generic', options: { headers: {} },
    });
    await dispatchResource({ type: 'dash', url: 'https://example.test/a.mpd' }, electronAPI, {
      filename: 'a.mp4', videoInfo: { title: 'a' }, platform: 'generic', options: {},
    });
    await dispatchResource({ type: 'video', url: 'https://example.test/a.mp4' }, electronAPI, {
      filename: 'a.mp4', videoInfo: { title: 'a' }, platform: 'generic', options: {},
    });
    assert.deepEqual(calls.map(call => call[0]), ['downloadM3u8', 'downloadMpd', 'downloadFile']);
    await assert.rejects(
      dispatchResource({ type: 'rtmp', url: 'rtmp://example.test/live' }, electronAPI, {
        filename: 'live.flv', videoInfo: { title: 'live' }, platform: 'douyin', options: {},
      }),
      /拒绝/,
    );
  });

  await t.test('spreadsheet sanitizer neutralizes dangerous prefixes before CSV escaping', async () => {
    const source = readFileSync(new URL('../src/utils/csvExport.js', import.meta.url), 'utf8');
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const { arrayToCSV, sanitizeSpreadsheetCell } = await import(moduleUrl);
    assert.equal(sanitizeSpreadsheetCell('=2+2'), "'=2+2");
    assert.equal(sanitizeSpreadsheetCell(' \t@SUM(A1)'), "' \t@SUM(A1)");
    assert.equal(sanitizeSpreadsheetCell(42), 42);
    assert.equal(arrayToCSV([{ value: '+cmd' }], [{ key: 'value', label: '值' }]), "值\n'+cmd");
  });

  await t.test('automatic Douyin quality chooses height then bitrate before ordinary play_addr', async () => {
    const source = readFileSync(new URL('../src/utils/douyinWork.js', import.meta.url), 'utf8');
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const { pickQualityUrl } = await import(moduleUrl);
    const item = {
      video: {
        play_addr: { url_list: ['ordinary'] },
        bit_rate: [
          { bit_rate: 5000, play_addr: { height: 720, url_list: ['720-high'] } },
          { bit_rate: 1000, play_addr: { height: 1080, url_list: ['1080-low'] } },
          { bit_rate: 2000, play_addr: { height: 1080, url_list: ['1080-high'] } },
        ],
      },
    };
    assert.equal(pickQualityUrl(item, 'auto'), '1080-high');
    assert.equal(pickQualityUrl(item, '1080'), '1080-high');
  });
}
