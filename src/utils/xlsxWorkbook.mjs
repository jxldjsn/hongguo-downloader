const DANGEROUS_FORMULA_PREFIX = /^[\s\u0000-\u001f]*[=+\-@]/;

export function sanitizeWorkbookCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : new Date(value.getTime());
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  const text = typeof value === 'string' ? value : String(value);
  return DANGEROUS_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function normalizeSheetName(value) {
  const name = String(value || '作品数据').replace(/[\\/*?:\[\]]/g, '_').slice(0, 31);
  return name || '作品数据';
}

function normalizeColumns(columns, rows) {
  const source = Array.isArray(columns) && columns.length > 0
    ? columns
    : Object.keys(rows[0] || {}).map(key => ({ header: key, key }));

  return source.map((column, index) => {
    const key = String(column?.key || `column_${index + 1}`);
    const width = Number(column?.width);
    return {
      key,
      header: sanitizeWorkbookCell(column?.header ?? key),
      width: Number.isFinite(width) && width > 0 ? Math.min(width, 100) : 15,
    };
  });
}

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new TypeError('ExcelJS returned an unsupported workbook buffer');
}

export async function buildWorkbookBuffer(rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const columns = normalizeColumns(options.columns, safeRows);
  const excelModule = await import('exceljs');
  const ExcelJS = excelModule.default || excelModule;
  if (typeof ExcelJS.Workbook !== 'function') {
    throw new Error('ExcelJS Workbook constructor is unavailable');
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Douyin Downloader';
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(normalizeSheetName(options.sheetName));
  worksheet.columns = columns;

  for (const sourceRow of safeRows) {
    const row = {};
    for (const column of columns) {
      row[column.key] = sanitizeWorkbookCell(sourceRow?.[column.key]);
    }
    worksheet.addRow(row);
  }

  if (columns.length > 0) {
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };
  }

  return toArrayBuffer(await workbook.xlsx.writeBuffer());
}

