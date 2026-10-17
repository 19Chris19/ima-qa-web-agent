// Offline rollback preparation only. No pool, browser, upstream or network.
const fs = require('node:fs');
const path = require('node:path');
const { AsyncAccountDirectory } = require('../src/async-account-directory');
async function finalize(args) {
  if (args.length !== 5 || args[0] !== '--store' || args[2] !== '--key' || args[4] !== '--confirm-offline') throw Error('usage_store_key_confirm_offline');
  const [file, key] = [args[1], args[3]];
  for (const value of [file, key]) {
    if (!path.isAbsolute(value) || fs.realpathSync(value) !== value) throw Error('existing_private_file_required');
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw Error('existing_private_file_required');
  }
  const directory = await new AsyncAccountDirectory({ storePath: file, keyPath: key }).initialize();
  try { const accounts = directory.listAccounts().length; await directory.close(); return { statisticsMirrored: true, accounts, realIMA: false }; }
  finally { await directory.close().catch(() => {}); }
}
if (require.main === module) finalize(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), () => {
  console.error('offline_statistics_finalize_failed'); process.exitCode = 1;
});
module.exports = { finalize };
