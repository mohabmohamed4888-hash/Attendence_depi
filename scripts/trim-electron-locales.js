// Electron ships ~55 locale packs (~48 MB). This app is English/Arabic only,
// so the rest are removed after every install to keep node_modules smaller.
// Runs as a postinstall hook; never fails the install.
const fs = require('fs');
const path = require('path');

const KEEP = new Set(['en-US.pak', 'en-GB.pak', 'ar.pak']);
const localesDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'locales');

try {
  if (!fs.existsSync(localesDir)) process.exit(0);

  let removed = 0;
  let freed = 0;
  for (const file of fs.readdirSync(localesDir)) {
    if (KEEP.has(file)) continue;
    const target = path.join(localesDir, file);
    freed += fs.statSync(target).size;
    fs.unlinkSync(target);
    removed += 1;
  }

  if (removed) {
    console.log(`Trimmed ${removed} unused Electron locale packs (${Math.round(freed / 1024 / 1024)} MB).`);
  }
} catch (error) {
  console.log(`Skipped Electron locale trim: ${error.message}`);
}
