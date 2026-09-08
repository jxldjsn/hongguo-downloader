'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertWin64Pe } = require('./verify-win64-tools');

function assertNonEmptyFile(name, filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`[afterPack] ${name} is missing: ${filePath}`, { cause: error });
  }
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`[afterPack] ${name} is empty or not a file: ${filePath}`);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    throw new Error(
      `[afterPack] Unsupported platform "${context.electronPlatformName}"; this application ships only for Windows x64.`,
    );
  }

  if (!context.packager || typeof context.packager.getResourcesDir !== 'function') {
    throw new Error('[afterPack] electron-builder did not provide a resource-directory resolver.');
  }

  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const archivePath = path.join(resourcesDir, 'app.asar');
  const unpackedDir = `${archivePath}.unpacked`;
  const productFilename = context.packager.appInfo && context.packager.appInfo.productFilename;
  if (!productFilename) {
    throw new Error('[afterPack] electron-builder did not provide the product filename.');
  }

  const packagedTools = {
    Electron: path.join(context.appOutDir, `${productFilename}.exe`),
    'yt-dlp': path.join(unpackedDir, 'assets', 'yt-dlp.exe'),
    ffmpeg: path.join(unpackedDir, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  };

  assertNonEmptyFile('app.asar', archivePath);
  for (const [name, filePath] of Object.entries(packagedTools)) {
    assertNonEmptyFile(name, filePath);
    assertWin64Pe(name, filePath);
    console.log(`[afterPack] ${name}: Windows x64`);
  }

  console.log(`[afterPack] Windows x64 resources verified: ${resourcesDir}`);
};
