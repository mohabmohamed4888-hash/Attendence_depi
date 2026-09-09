const fs = require('fs');
const path = require('path');

function resolveGroupsWorkbookPath(baseDir = __dirname) {
  const candidates = [
    'groups.xlsx',
    'groups_all_merged_complete.xlsx',
  ];

  for (const fileName of candidates) {
    const filePath = path.join(baseDir, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }

  throw new Error(
    `Groups workbook not found. Expected one of: ${candidates.join(', ')}`
  );
}

module.exports = { resolveGroupsWorkbookPath };
