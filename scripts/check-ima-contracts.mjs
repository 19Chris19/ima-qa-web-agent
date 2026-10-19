import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalogTools from '../src/ima-contract-catalog.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const result = catalogTools.validateCatalog(JSON.parse(fs.readFileSync(path.join(root, 'contracts/ima-capabilities.v1.json'), 'utf8')), root);
  for (const name of fs.readdirSync(path.join(root, 'contracts/fixtures'))) {
    if (name.endsWith('.json')) catalogTools.checkScrubbedFixture(JSON.parse(fs.readFileSync(path.join(root, 'contracts/fixtures', name), 'utf8')));
  }
  console.log(JSON.stringify(result));
} catch { console.error('ima_contract_check_failed'); process.exitCode = 1; }
