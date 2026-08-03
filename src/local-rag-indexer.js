const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanText, truncateText } = require('./evidence-pack');

const execFileAsync = promisify(execFile);
const DEFAULT_CHUNK_MAX_CHARS = 1800;
const DEFAULT_CHUNK_OVERLAP_MESSAGES = 4;
const DEFAULT_MIN_CHUNK_CHARS = 160;
const DEFAULT_MAX_INDEXED_TERM_LENGTH = 48;

function defaultIndexDir() {
  return path.resolve(__dirname, '..', '..', '..', 'runtime', 'ima-local-rag-index');
}

async function buildLocalRagIndex(options = {}) {
  const corpusZip = String(options.corpusZip || '').trim();
  const corpusDir = String(options.corpusDir || '').trim();
  const indexDir = path.resolve(options.indexDir || defaultIndexDir());
  const chunkMaxChars = Number(options.chunkMaxChars || DEFAULT_CHUNK_MAX_CHARS);
  const overlapMessages = Number(options.chunkOverlapMessages || DEFAULT_CHUNK_OVERLAP_MESSAGES);

  if (!corpusZip && !corpusDir) {
    throw new Error('LOCAL_RAG_CORPUS_ZIP or LOCAL_RAG_CORPUS_DIR is required');
  }

  const files = corpusZip
    ? await readMarkdownFilesFromZip(corpusZip)
    : await readMarkdownFilesFromDir(corpusDir);

  const chunks = [];
  for (const file of files) {
    chunks.push(
      ...chunkRawMarkdown(file.relativePath, file.content, {
        chunkMaxChars,
        overlapMessages,
      }),
    );
  }

  const index = buildSearchIndex(chunks, {
    corpusZip,
    corpusDir,
    chunkMaxChars,
    overlapMessages,
  });

  fs.mkdirSync(indexDir, { recursive: true });
  const indexPath = path.join(indexDir, 'index.json');
  const tempPath = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(index));
  fs.renameSync(tempPath, indexPath);
  return { indexPath, stats: index.stats };
}

async function readMarkdownFilesFromZip(zipPath) {
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 20 * 1024 * 1024 });
  const entries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((entry) => entry.endsWith('.md'));

  const files = [];
  for (const entry of entries) {
    const { stdout: content } = await execFileAsync('unzip', ['-p', zipPath, entry], {
      maxBuffer: 30 * 1024 * 1024,
    });
    files.push({ relativePath: entry, content });
  }
  return files;
}

async function readMarkdownFilesFromDir(corpusDir) {
  const root = path.resolve(corpusDir);
  const files = [];
  for (const filePath of walkMarkdownFiles(root)) {
    files.push({
      relativePath: path.relative(root, filePath),
      content: fs.readFileSync(filePath, 'utf8'),
    });
  }
  return files;
}

function* walkMarkdownFiles(root) {
  for (const name of fs.readdirSync(root)) {
    const filePath = path.join(root, name);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      yield* walkMarkdownFiles(filePath);
    } else if (filePath.endsWith('.md')) {
      yield filePath;
    }
  }
}

function chunkRawMarkdown(relativePath, content, options = {}) {
  const metadata = parseFileMetadata(relativePath, content);
  const messages = parseMessages(content, metadata);
  if (messages.length === 0) {
    return chunkByParagraphs(relativePath, content, metadata, options);
  }
  return chunkMessages(relativePath, messages, metadata, options);
}

function parseFileMetadata(relativePath, content) {
  const normalizedPath = String(relativePath || '');
  const groupFromPath = normalizedPath.match(/\/(group\d+)\//i)?.[1] || '';
  const dateFromPath = normalizedPath.match(/(\d{4})(\d{2})(\d{2})/) || [];
  const titleFromHeader =
    content.match(/^- source_title:\s*`([^`]+)`/m)?.[1] ||
    content.match(/^#\s+(.+)$/m)?.[1] ||
    path.basename(normalizedPath);
  const date = dateFromPath.length
    ? `${dateFromPath[1]}-${dateFromPath[2]}-${dateFromPath[3]}`
    : '';

  return {
    group: groupFromPath || content.match(/group_alias:\s*`([^`]+)`/i)?.[1] || 'unknown-group',
    date,
    title: cleanText(titleFromHeader),
  };
}

function parseMessages(content, metadata = {}) {
  const lines = String(content || '').split(/\r?\n/);
  const messages = [];
  let current = null;
  let inMultimodalBlock = false;

  for (const line of lines) {
    if (/<!--\s*multimodal:begin/i.test(line)) {
      inMultimodalBlock = true;
    }
    if (/<!--\s*multimodal:end/i.test(line)) {
      inMultimodalBlock = false;
      continue;
    }

    const parsed = parseMessageLine(line, metadata);
    if (parsed) {
      current = parsed;
      messages.push(current);
      continue;
    }

    if (current && line.trim() && (inMultimodalBlock || !line.startsWith('#'))) {
      current.text = cleanMessageText(`${current.text}\n${line.trim()}`);
    }
  }

  return messages.filter((message) => isUsefulMessage(message.text));
}

function parseMessageLine(line, metadata = {}) {
  const trimmed = String(line || '').trim();
  const bullet = trimmed.match(/^-\s+\[(\d{2}:\d{2}:\d{2})\]\s+([^:：]+)[:：]\s*(.*)$/);
  if (bullet) {
    return {
      time: metadata.date ? `${metadata.date} ${bullet[1]}` : bullet[1],
      speaker: cleanText(bullet[2]),
      text: cleanMessageText(bullet[3]),
    };
  }

  const iso = trimmed.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s+([^:：]+)[:：]\s*(.*)$/);
  if (iso) {
    return {
      time: iso[1],
      speaker: cleanText(iso[2]),
      text: cleanMessageText(iso[3]),
    };
  }

  return null;
}

function cleanMessageText(value) {
  return cleanText(value)
    .replace(/^wxid_[a-z0-9_]+:\s*/i, '')
    .replace(/^["“][^"”]+["”]\s*(?:邀请|与群里其他人|撤回).*/, '')
    .trim();
}

function isUsefulMessage(text) {
  const value = cleanText(text);
  if (!value) {
    return false;
  }
  if (/^\[(图片|视频|表情|动画表情|聊天记录)\]$/.test(value)) {
    return false;
  }
  if (/^(撤回了一条消息|与群里其他人都不是朋友关系)/.test(value)) {
    return false;
  }
  return value.length >= 2;
}

function chunkMessages(relativePath, messages, metadata, options = {}) {
  const chunkMaxChars = Number(options.chunkMaxChars || DEFAULT_CHUNK_MAX_CHARS);
  const overlapMessages = Number(options.overlapMessages || DEFAULT_CHUNK_OVERLAP_MESSAGES);
  const chunks = [];
  let buffer = [];
  let bufferChars = 0;

  const flush = () => {
    if (!buffer.length) {
      return;
    }
    const text = buffer.map(formatMessage).join('\n');
    if (text.length >= DEFAULT_MIN_CHUNK_CHARS || chunks.length === 0) {
      chunks.push(createChunk(relativePath, text, metadata, buffer, chunks.length));
    }
    buffer = buffer.slice(Math.max(0, buffer.length - overlapMessages));
    bufferChars = buffer.reduce((sum, message) => sum + formatMessage(message).length + 1, 0);
  };

  for (const message of messages) {
    const formattedLength = formatMessage(message).length + 1;
    if (buffer.length && bufferChars + formattedLength > chunkMaxChars) {
      flush();
    }
    buffer.push(message);
    bufferChars += formattedLength;
  }
  flush();

  return chunks;
}

function chunkByParagraphs(relativePath, content, metadata, options = {}) {
  const chunkMaxChars = Number(options.chunkMaxChars || DEFAULT_CHUNK_MAX_CHARS);
  const paragraphs = String(content || '')
    .split(/\n{2,}/)
    .map(cleanText)
    .filter(Boolean);
  const chunks = [];
  let text = '';
  for (const paragraph of paragraphs) {
    if (text && text.length + paragraph.length + 2 > chunkMaxChars) {
      chunks.push(createChunk(relativePath, text, metadata, [], chunks.length));
      text = '';
    }
    text = text ? `${text}\n\n${paragraph}` : paragraph;
  }
  if (text) {
    chunks.push(createChunk(relativePath, text, metadata, [], chunks.length));
  }
  return chunks;
}

function formatMessage(message) {
  return `[${message.time}] ${message.speaker}: ${message.text}`;
}

function createChunk(relativePath, text, metadata, messages, localIndex) {
  const start = messages[0]?.time || metadata.date || '';
  const end = messages[messages.length - 1]?.time || start;
  const titleParts = [metadata.group, metadata.date || start, timeLabel(start, end)].filter(Boolean);
  return {
    id: `${relativePath}#${localIndex + 1}`,
    mediaId: `${relativePath}#${localIndex + 1}`,
    title: titleParts.join(' / '),
    snippet: truncateText(text, 2200),
    filePath: relativePath,
    group: metadata.group,
    date: metadata.date,
    startTime: start,
    endTime: end,
    messageCount: messages.length || null,
  };
}

function timeLabel(start, end) {
  const left = String(start || '').match(/(\d{2}:\d{2}:\d{2})/)?.[1] || '';
  const right = String(end || '').match(/(\d{2}:\d{2}:\d{2})/)?.[1] || '';
  if (!left || left === right) {
    return left;
  }
  return `${left}-${right}`;
}

function buildSearchIndex(chunks, metadata = {}) {
  const postings = {};
  const docLengths = [];
  const storedChunks = chunks.map((chunk, index) => {
    const terms = countTerms(tokenizeForSearch(`${chunk.title}\n${chunk.snippet}`));
    docLengths[index] = Object.values(terms).reduce((sum, count) => sum + count, 0);
    for (const [term, count] of Object.entries(terms)) {
      if (term.length > DEFAULT_MAX_INDEXED_TERM_LENGTH) {
        continue;
      }
      postings[term] ||= [];
      postings[term].push([index, count]);
    }
    return chunk;
  });

  const avgDocLength =
    docLengths.reduce((sum, value) => sum + value, 0) / Math.max(docLengths.length, 1);

  return {
    version: 1,
    provider: 'local-rag-mimo',
    builtAt: new Date().toISOString(),
    metadata,
    stats: {
      fileCount: new Set(chunks.map((chunk) => chunk.filePath)).size,
      chunkCount: storedChunks.length,
      termCount: Object.keys(postings).length,
      avgDocLength,
    },
    chunks: storedChunks,
    postings,
    docLengths,
  };
}

function tokenizeForSearch(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/wxid_[a-z0-9_]+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}t?\d{0,2}:?\d{0,2}:?\d{0,2}\b/g, ' ')
    .replace(/\b\d{7,}\b/g, ' ');
  const tokens = [];
  const ascii = normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || [];
  tokens.push(...ascii.filter((token) => !/^\d+(?:[._+-]\d+)*$/.test(token)));

  const chineseRuns = normalized.match(/\p{Script=Han}+/gu) || [];
  for (const run of chineseRuns) {
    if (run.length <= 4) {
      tokens.push(run);
    }
    for (let index = 0; index <= run.length - 2; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }

  return tokens.filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function countTerms(tokens) {
  const counts = {};
  for (const token of tokens) {
    counts[token] = (counts[token] || 0) + 1;
  }
  return counts;
}

const STOP_WORDS = new Set([
  '这个',
  '那个',
  '就是',
  '可以',
  '怎么',
  '什么',
  '一下',
  '一个',
  '我们',
  '你们',
  '他们',
  '因为',
  '所以',
  '但是',
  '如果',
  '今天',
  '今晚',
  '天晚',
  '晚上',
  '上吃',
  '吃什',
  '是否',
  '哪些',
  '如何',
  '为什么',
  '定义',
  '原理',
  '流程',
  '应用',
  '边界',
  '误解',
  '案例',
  '方案',
  '问题',
  '主要',
  '需要',
  '进行',
  '使用',
  '时候',
  '方面',
  'the',
  'and',
  'for',
  'with',
]);

module.exports = {
  DEFAULT_CHUNK_MAX_CHARS,
  DEFAULT_CHUNK_OVERLAP_MESSAGES,
  buildLocalRagIndex,
  buildSearchIndex,
  chunkRawMarkdown,
  cleanMessageText,
  defaultIndexDir,
  parseFileMetadata,
  parseMessageLine,
  parseMessages,
  tokenizeForSearch,
};
