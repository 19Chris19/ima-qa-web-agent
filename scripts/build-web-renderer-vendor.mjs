import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'public', 'vendor');
mkdirSync(output, { recursive: true });
for (const [source, destination] of [
  ['marked/lib/marked.umd.js', 'marked.umd.js'],
  ['marked/LICENSE.md', 'marked.LICENSE.md'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
  ['dompurify/LICENSE', 'dompurify.LICENSE'],
]) {
  copyFileSync(join(root, 'node_modules', source), join(output, destination));
}
