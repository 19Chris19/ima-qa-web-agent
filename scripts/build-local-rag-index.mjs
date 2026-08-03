#!/usr/bin/env node
import 'dotenv/config';
import localRagIndexer from '../src/local-rag-indexer.js';

const { buildLocalRagIndex, defaultIndexDir } = localRagIndexer;

function readArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

const options = {
  corpusZip: readArg('zip') || process.env.LOCAL_RAG_CORPUS_ZIP,
  corpusDir: readArg('dir') || process.env.LOCAL_RAG_CORPUS_DIR,
  indexDir: readArg('index-dir') || process.env.LOCAL_RAG_INDEX_DIR || defaultIndexDir(),
  chunkMaxChars: Number(readArg('chunk-size') || process.env.LOCAL_RAG_CHUNK_SIZE || 1800),
  chunkOverlapMessages: Number(
    readArg('chunk-overlap') || process.env.LOCAL_RAG_CHUNK_OVERLAP_MESSAGES || 4,
  ),
};

try {
  const { indexPath, stats } = await buildLocalRagIndex(options);
  console.log(`Local RAG index built: ${indexPath}`);
  console.log(JSON.stringify(stats, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
