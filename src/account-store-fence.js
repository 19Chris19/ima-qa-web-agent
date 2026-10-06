const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');

async function acquireAccountStoreFence(storePath) {
  const absolute = path.resolve(storePath);
  const canonical = fs.existsSync(absolute) ? fs.realpathSync(absolute)
    : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  // Separate from short-lived write locks: readers/refresh owners hold this until exit.
  try {
    return await lockfile.lock(`${canonical}.service-fence`, {
      realpath: false, retries: 0, stale: 120000, update: 2000,
    });
  } catch (error) {
    if (error.code === 'ELOCKED') {
      throw Object.assign(new Error('account_store_in_use'), { code: 'account_store_in_use' });
    }
    throw error;
  }
}

module.exports = { acquireAccountStoreFence };
