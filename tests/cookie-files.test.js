'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCookieArgs,
  cleanupCookieFile,
  cleanupCookieFiles,
  cleanupStaleCookieFiles,
  writeCookieFile,
} = require('../src/native/ytCookieFile');

test('yt-dlp cookie arguments contain only a Netscape file path, never the secret value', t => {
  const args = buildCookieArgs('SESSDATA=plain-secret', {
    platform: 'bilibili',
    domain: '.bilibili.com',
  });
  t.after(() => cleanupCookieFile(args[1]));

  assert.equal(args[0], '--cookies');
  assert.match(path.basename(args[1]), /^bilibili-cookies-[a-f0-9]{12}\.txt$/);
  assert.equal(args.some(arg => String(arg).includes('plain-secret')), false);
  assert.match(fs.readFileSync(args[1], 'utf8'), /\.bilibili\.com[\s\S]*SESSDATA\tplain-secret/);
});

test('xiaohongshu cookies write to an owned netscape file for yt-dlp', t => {
  const args = buildCookieArgs('web_session=xhs-secret; a1=abc', {
    platform: 'xiaohongshu',
    domain: '.xiaohongshu.com',
  });
  t.after(() => cleanupCookieFile(args[1]));

  assert.equal(args[0], '--cookies');
  assert.match(path.basename(args[1]), /^xiaohongshu-cookies-[a-f0-9]{12}\.txt$/);
  assert.match(fs.readFileSync(args[1], 'utf8'), /\.xiaohongshu\.com[\s\S]*web_session\txhs-secret/);
});

test('cookie cleanup only removes owned files for the requested platform', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-files-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const youtube = writeCookieFile('SID=youtube', { prefix: 'youtube-cookies', tempDir });
  const bilibili = writeCookieFile('SESSDATA=bilibili', { prefix: 'bilibili-cookies', tempDir });
  const unrelated = path.join(tempDir, 'notes.txt');
  fs.writeFileSync(unrelated, 'keep');

  assert.equal(cleanupCookieFiles({ platform: 'youtube', tempDir }), 1);
  assert.equal(fs.existsSync(youtube), false);
  assert.equal(fs.existsSync(bilibili), true);
  assert.equal(fs.existsSync(unrelated), true);
});

test('startup cleanup removes stale owned cookie files but leaves fresh ones', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-files-stale-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const now = Date.now();
  const stale = writeCookieFile('SID=stale', { prefix: 'youtube-cookies', tempDir });
  const fresh = writeCookieFile('SID=fresh', { prefix: 'youtube-cookies', tempDir });
  const staleTime = new Date(now - (48 * 60 * 60 * 1000));
  fs.utimesSync(stale, staleTime, staleTime);

  assert.equal(cleanupStaleCookieFiles({ tempDir, now, maxAgeMs: 24 * 60 * 60 * 1000 }), 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});
