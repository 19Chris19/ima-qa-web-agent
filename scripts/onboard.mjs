#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import deployment from '../src/guided-deployment.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (process.argv[2] === 'runtime') console.log(process.execPath);
  else await deployment.guided(root, process.argv[2] || 'doctor', deployment.parseOptions(process.argv.slice(3)));
} catch (error) {
  const code = /^[a-z_]+$/.test(error.code || '') ? error.code : 'guided_operation_failed';
  console.error(JSON.stringify({ stage: 'blocked', code, credentialsPrinted: false,
    next: 'Read docs/AGENT_DEPLOYMENT.md; do not reinitialize existing state.' }));
  process.exitCode = 1;
}
