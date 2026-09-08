'use strict';

const YTDLP_OUTPUT_MARKER = '__APP_OUTPUT__';

function summarizeItems(results) {
  const items = Array.isArray(results) ? results : [];
  const failures = items.filter(item => !item || item.ok !== true);
  const succeeded = items.length - failures.length;
  return {
    status: items.length > 0 && failures.length === 0 ? 'completed' : 'partial',
    succeeded,
    failed: failures.length,
    failures,
  };
}

function escapeSpreadsheetCSVCell(value) {
  if (value === null || typeof value === 'undefined') return '';
  let stringValue = String(value);
  if (/^[=+\-@]/.test(stringValue)) stringValue = `'${stringValue}`;
  if (/[,"\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function parseYtdlpOutputLine(line) {
  const text = String(line ?? '').replace(/[\r\n]+$/, '');
  if (!text.startsWith(YTDLP_OUTPUT_MARKER)) return null;
  const outputPath = text.slice(YTDLP_OUTPUT_MARKER.length).trim();
  return outputPath || null;
}

module.exports = {
  YTDLP_OUTPUT_MARKER,
  summarizeItems,
  escapeSpreadsheetCSVCell,
  parseYtdlpOutputLine,
};

