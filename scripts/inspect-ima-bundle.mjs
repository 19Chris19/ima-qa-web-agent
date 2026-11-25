import fs from 'node:fs';
import tools from '../src/ima-contract-catalog.js';
// Offline only: neither fetch nor evaluation is available in this tool.
try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--bundle-file', '--source-url', '--sampled-at'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw Error();
    options[args[i]] = args[i + 1];
  }
  const file = options['--bundle-file'];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error();
  console.log(JSON.stringify(tools.inspectPublicBundle(fs.readFileSync(file), {
    sourceUrl: options['--source-url'], sampledAt: options['--sampled-at'],
  }), null, 2));
} catch { console.error('ima_bundle_inspection_failed'); process.exitCode = 1; }
