'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const SUPPORTED_PE_MACHINES = new Set([IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_I386]);

function readExactly(fileDescriptor, length, position, filePath) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`${filePath} is truncated`);
  }
  return buffer;
}

function readPeMachine(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Executable is missing: ${resolvedPath}`);
  }

  const fileDescriptor = fs.openSync(resolvedPath, 'r');
  try {
    const dosHeader = readExactly(fileDescriptor, 0x40, 0, resolvedPath);
    if (dosHeader.subarray(0, 2).toString('ascii') !== 'MZ') {
      throw new Error(`${resolvedPath} is not a Windows PE executable`);
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = readExactly(fileDescriptor, 6, peOffset, resolvedPath);
    if (peHeader.subarray(0, 4).toString('binary') !== 'PE\0\0') {
      throw new Error(`${resolvedPath} has an invalid PE header`);
    }
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function assertWin64Pe(name, filePath) {
  const resolvedPath = path.resolve(filePath);
  const machine = readPeMachine(resolvedPath);
  if (!SUPPORTED_PE_MACHINES.has(machine)) {
    throw new Error(
      `${name} must be a Windows PE executable (expected 0x8664 or 0x14c, got 0x${machine.toString(16)}): ${resolvedPath}`,
    );
  }
  return resolvedPath;
}

function getDevelopmentToolPaths(projectRoot = path.resolve(__dirname, '..')) {
  return {
    Electron: require('electron'),
    'yt-dlp': path.join(projectRoot, 'assets', 'yt-dlp.exe'),
    ffmpeg: require('ffmpeg-static'),
  };
}

function verifyDevelopmentTools(projectRoot) {
  const verified = [];
  for (const [name, filePath] of Object.entries(getDevelopmentToolPaths(projectRoot))) {
    verified.push({ name, filePath: assertWin64Pe(name, filePath) });
  }
  return verified;
}

if (require.main === module) {
  try {
    for (const { name, filePath } of verifyDevelopmentTools()) {
      console.log(`[win64] ${name}: x64 (${filePath})`);
    }
  } catch (error) {
    console.error(`[win64] Verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_I386,
  SUPPORTED_PE_MACHINES,
  readPeMachine,
  assertWin64Pe,
  getDevelopmentToolPaths,
  verifyDevelopmentTools,
};
