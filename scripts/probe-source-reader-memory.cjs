'use strict';
const { SourceReader } = require('../src/source-reader');
async function main() {
  const kind = process.argv[2];
  if (!['text_limit', 'pdf_probe'].includes(kind)) throw new Error();
  const reader = new SourceReader();
  const bytes = kind === 'text_limit' ? Buffer.alloc(5 * 1024 * 1024 - 1, 65) : require('./test-fixtures/source-reader-pdf.cjs')();
  const base = process.memoryUsage().rss; let peak = base;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
  let result;
  try {
    const value = await reader.run({ kind: 'extract', bytes, type: kind === 'text_limit' ? 'text/plain' : 'application/pdf', pdfEnabled: kind === 'pdf_probe' });
    result = { extracted: true, characters: value.extractedCharacters, contentComplete: value.contentComplete };
  } catch (error) { result = { extracted: false, error: /^source_[a-z_]+$/u.test(error.code || '') ? error.code : 'probe_failed' }; }
  clearInterval(sample); await reader.close();
  process.stdout.write(JSON.stringify({ kind, inputBytes: bytes.length, inputBufferInParent: true, ...result, extraRssPeakBytes: peak - base,
    rssUnder64MiB: peak - base <= 64 * 1024 * 1024, publicEnabled: kind !== 'pdf_probe' }) + '\n');
}
main().catch(() => { process.stderr.write('{"error":"memory_probe_failed"}\n'); process.exitCode = 1; });
