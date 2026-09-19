/* =======================
   EXPORTS CLEANUP
   Empties the per-session attendance CSVs out of exports/ once they are on
   the LMS, so the folder does not pile up run after run:

     exports/<CATEGORY>/<GROUP_NAME>/<DATE>_<TYPE>_<GROUP>.csv   <- deleted
     exports/<CATEGORY>/<GROUP_NAME>/                            <- removed when empty

   A CSV listed in exports/pending_reuploads.json is never deleted: it was
   rewritten after it was uploaded and still has to go up to the LMS again.

   Nothing else is touched. The session titles (CSV Titles), the upload
   reports and the tracking files stay where they are, and every deleted CSV
   can be produced again by running the attendance export for its dates.
======================= */

const fs = require('fs');
const path = require('path');

const PENDING_REUPLOADS_FILE = 'pending_reuploads.json';
const TITLES_DIR_NAME = 'CSV Titles';
const CATEGORY_DIRS = ['Technical groups', 'Non Technical groups', 'Others'];

// exports/<CATEGORY>/<GROUP>/<file>.csv -> "<CATEGORY>/<GROUP>/<file>.csv"
function relativeKey(exportDir, filePath) {
  return path.relative(exportDir, filePath).split(path.sep).join('/');
}

function readPendingReuploads(exportDir, log = console.log) {
  const filePath = path.join(exportDir, PENDING_REUPLOADS_FILE);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Set(Object.keys(parsed));
    }
  } catch (error) {
    // A list that cannot be read must not lead to deleting files it protects.
    throw new Error(
      `${PENDING_REUPLOADS_FILE} could not be read (${error.message}); ` +
      'nothing was deleted so no CSV waiting for re-upload is lost.'
    );
  }
  return new Set();
}

/* Lists every per-session attendance CSV under exports/. */
function listSessionCsvs(exportDir) {
  const files = [];
  for (const category of CATEGORY_DIRS) {
    const categoryDir = path.join(exportDir, category);
    if (!fs.existsSync(categoryDir)) continue;

    for (const groupName of fs.readdirSync(categoryDir)) {
      if (groupName === TITLES_DIR_NAME) continue;
      const groupDir = path.join(categoryDir, groupName);
      let stat;
      try {
        stat = fs.statSync(groupDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      for (const fileName of fs.readdirSync(groupDir)) {
        if (!fileName.toLowerCase().endsWith('.csv')) continue;
        const filePath = path.join(groupDir, fileName);
        if (!fs.statSync(filePath).isFile()) continue;
        files.push({ filePath, groupDir, group: groupName, category, fileName });
      }
    }
  }
  return files;
}

/* Removes a group folder once its last CSV is gone. */
function removeEmptyGroupDirs(groupDirs) {
  const removed = [];
  for (const groupDir of groupDirs) {
    try {
      if (fs.existsSync(groupDir) && fs.readdirSync(groupDir).length === 0) {
        fs.rmdirSync(groupDir);
        removed.push(groupDir);
      }
    } catch {
      // A folder that will not go away is harmless; the CSVs are already gone.
    }
  }
  return removed;
}

/* options: { dryRun } — dryRun reports what would go without deleting it. */
function cleanExports(exportDir, { dryRun = false, log = console.log } = {}) {
  const summary = { deleted: [], kept: [], failed: [], removedDirs: [] };

  if (!fs.existsSync(exportDir)) {
    log(`⚠️ Exports folder not found: ${exportDir}`);
    return summary;
  }

  const pending = readPendingReuploads(exportDir, log);
  const files = listSessionCsvs(exportDir);

  if (!files.length) {
    log('✅ No session CSVs in exports — nothing to clean.');
    return summary;
  }

  log(`🧹 ${files.length} session CSV(s) found in exports.`);
  if (pending.size) {
    log(`⏭️ ${pending.size} of them may still be waiting for an LMS re-upload and will be kept.`);
  }

  const touchedGroupDirs = new Set();

  for (const file of files) {
    const key = relativeKey(exportDir, file.filePath);

    if (pending.has(key)) {
      summary.kept.push(key);
      log(`⏭️ Kept (waiting for re-upload): ${key}`);
      continue;
    }

    if (dryRun) {
      summary.deleted.push(key);
      continue;
    }

    try {
      fs.unlinkSync(file.filePath);
      summary.deleted.push(key);
      touchedGroupDirs.add(file.groupDir);
    } catch (error) {
      const reason = String(error.message).split('\n')[0];
      summary.failed.push({ key, reason });
      log(`❌ Could not delete ${key}: ${reason}`);
    }
  }

  if (!dryRun) {
    summary.removedDirs = removeEmptyGroupDirs([...touchedGroupDirs]);
  }

  log('');
  log(`🗑️ Deleted: ${summary.deleted.length} session CSV(s)`);
  if (summary.kept.length) log(`📌 Kept (waiting for re-upload): ${summary.kept.length}`);
  if (summary.failed.length) {
    log(`❌ Could not delete: ${summary.failed.length} (is a file open in Excel?)`);
  }
  if (summary.removedDirs.length) log(`📁 Empty group folders removed: ${summary.removedDirs.length}`);
  log('ℹ️ Session titles, upload reports and the tracking files were left untouched.');
  log('ℹ️ Any deleted CSV comes back by running the attendance export for its dates.');

  return summary;
}

module.exports = {
  PENDING_REUPLOADS_FILE,
  TITLES_DIR_NAME,
  CATEGORY_DIRS,
  relativeKey,
  readPendingReuploads,
  listSessionCsvs,
  cleanExports,
};

/* =======================
   CLI: node exports_cleanup.js [--dry-run] [--exports <dir>]
   The desktop app runs this file so the deletion happens in its own process
   and the log streams into the Activity Log like every other operation.
======================= */
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dirIndex = args.indexOf('--exports');
  const exportDir = dirIndex !== -1 && args[dirIndex + 1]
    ? args[dirIndex + 1]
    : path.join(__dirname, 'exports');

  try {
    console.log(`🧹 Cleaning exports: ${exportDir}${dryRun ? ' (dry run)' : ''}`);
    const summary = cleanExports(exportDir, { dryRun });
    if (summary.failed.length) process.exitCode = 1;
    console.log('🎉 Done');
  } catch (error) {
    console.log(`[ERROR] ${String(error.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}
