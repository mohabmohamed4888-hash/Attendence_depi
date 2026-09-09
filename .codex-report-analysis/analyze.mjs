import fs from 'node:fs/promises';
import { Workbook } from '@oai/artifact-tool';

const reportPath = process.argv[2];
const csvText = await fs.readFile(reportPath, 'utf8');
const workbook = await Workbook.fromCSV(csvText, { sheetName: 'Report' });
const overview = await workbook.inspect({
  kind: 'workbook,sheet,table',
  maxChars: 8000,
  tableMaxRows: 140,
  tableMaxCols: 10,
  tableMaxCellChars: 180,
});
console.log(overview.ndjson);
