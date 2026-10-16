import { mkdir, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, fault } from './config.mjs';

export function projectEvidence(value) {
  if (!value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.scopeRef || '')) return null;
  const result = { schemaVersion: 1, scopeRef: value.scopeRef, materials: {}, citations: {} };
  for (const [ref, item] of Object.entries(value.materials || {}).slice(0, 100)) {
    if (!item || item.idNamespace !== 'ima_web_media' || typeof item.materialId !== 'string' || item.materialId.length > 2048
      || ref !== digest(JSON.stringify([value.scopeRef, item.idNamespace, item.materialId]))) continue;
    result.materials[ref] = { materialId: item.materialId, idNamespace: item.idNamespace,
      ...(typeof item.title === 'string' ? { title: item.title.slice(0, 512) } : {}),
      ...(typeof item.knowledgeBaseId === 'string' ? { knowledgeBaseId: item.knowledgeBaseId.slice(0, 512) } : {}),
      ...(Number.isSafeInteger(item.mediaType) ? { mediaType: item.mediaType } : {}),
      ...(item.conflicted === true ? { conflicted: true } : {}) };
  }
  for (const [key, entry] of Object.entries(value.citations || {}).slice(0, 100)) {
    if (!/^(index|context):[^\s?&#]{1,128}$/.test(key) || !entry || !['knowledge', 'web', 'unknown'].includes(entry.type)) continue;
    result.citations[key] = { type: entry.type,
      sourceRefs: [...new Set(Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [])].filter(ref => Object.hasOwn(result.materials, ref)).slice(0, 10),
      displayNumbers: [...new Set(Array.isArray(entry.displayNumbers) ? entry.displayNumbers : [])].filter(n => typeof n === 'string' && /^\d{1,6}$/.test(n)).slice(0, 100),
      ...(entry.conflicted === true ? { conflicted: true } : {}),
      ...(entry.positionFormat === 'upstream_opaque' && entry.upstreamPositions !== undefined && JSON.stringify(entry.upstreamPositions).length <= 2048
        ? { upstreamPositions: entry.upstreamPositions, positionFormat: 'upstream_opaque' } : {}) };
  }
  return result;
}
export function withMaterialReferences(map, evidence) {
  const result = { ...map };
  for (const [key, relation] of Object.entries(evidence?.citations || {})) {
    const old = result[key];
    if (old?.type !== 'knowledge' || old.conflicted || relation.type !== 'knowledge' || relation.conflicted) continue;
    result[key] = { ...old, materialRefs: relation.sourceRefs,
      displayNumbers: [...new Set([...(old.displayNumbers || []), ...relation.displayNumbers])] };
  }
  return result;
}
export function readPage(value, expected) {
  if (!value || value.schemaVersion !== 1 || value.taskId !== expected.taskId || value.citationKey !== expected.citationKey
    || !/^[a-f0-9]{64}$/.test(value.scopeRef || '') || (expected.scopeRef && value.scopeRef !== expected.scopeRef)
    || value.sourceRef !== expected.sourceRef || !/^[a-f0-9-]{36}$/.test(value.readId || '') || !/^[a-f0-9]{64}$/.test(value.sha256 || '')
    || value.idNamespace !== 'ima_web_media' || typeof value.materialId !== 'string' || value.materialId.length > 2048
    || typeof value.content !== 'string' || value.content.length > 8000 || !Number.isSafeInteger(value.offset) || value.offset < 0
    || !Number.isSafeInteger(value.extractedCharacters) || value.extractedCharacters > 128000 || value.offset + value.content.length > value.extractedCharacters
    || !Number.isFinite(Date.parse(value.readAt)) || !['note', 'text', 'markdown', 'html', 'pdf'].includes(value.format)
    || typeof value.contentComplete !== 'boolean' || typeof value.extractionTruncated !== 'boolean'
    || (value.rawSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.rawSha256))
    || (value.extractionScope !== undefined && !['first_five_pdf_pages', 'html_text', 'file_text', 'note_plain_text'].includes(value.extractionScope))
    || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.nextCursor)))) throw fault('invalid_source_read_response');
  const keys = ['schemaVersion', 'scopeRef', 'readerId', 'identityPolicy', 'taskId', 'citationKey', 'sourceRef', 'materialId', 'idNamespace', 'readId', 'readAt', 'content', 'offset',
    'nextCursor', 'sha256', 'rawSha256', 'format', 'extractionScope', 'extractedCharacters', 'contentComplete', 'extractionTruncated'];
  const result = Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  return { ...result, complete: value.contentComplete === true && value.nextCursor === null, trustedInstructions: false, snapshotAtAnswerTime: false };
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw fault('private_evidence_directory_required');
}
export async function archivePage(stateDir, page) {
  const directory = join(stateDir, 'evidence', page.taskId); await privateDirectory(directory);
  const text = JSON.stringify(page, null, 2) + '\n';
  const output = join(directory, page.readId + '-' + page.offset + '-' + digest(text).slice(0, 16) + '.json');
  try { await writeFile(output, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(output);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await readFile(output)) !== digest(text)) throw fault('modified_evidence_conflict');
  }
  return { output, sha256: digest(text), bytes: Buffer.byteLength(text) };
}
export async function readArchive(stateDir, taskId) {
  const directory = join(stateDir, 'evidence', taskId);
  let entries;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('invalid_evidence_archive');
    entries = await readdir(directory);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (entries.length > 256) throw fault('evidence_archive_capacity');
  const groups = new Map(); let bytes = 0;
  for (const name of entries.sort()) {
    if (!/^[a-f0-9-]{36}-\d+-[a-f0-9]{16}\.json$/.test(name)) throw fault('invalid_evidence_archive');
    const file = join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000 || (bytes += stat.size) > 4 * 1024 * 1024) throw fault('evidence_archive_capacity');
    const raw = await readFile(file, 'utf8');
    if (!name.endsWith('-' + digest(raw).slice(0, 16) + '.json')) throw fault('modified_evidence_conflict');
    const value = JSON.parse(raw), page = readPage(value, { ...value, taskId });
    const group = groups.get(page.readId) || []; group.push(page); groups.set(page.readId, group);
  }
  return [...groups.values()].map(pages => {
    pages.sort((a, b) => a.offset - b.offset); let end = 0;
    const first = pages[0], text = pages.map(page => page.content).join('');
    const contiguous = pages.every(page => {
      const okay = page.offset === end && ['scopeRef', 'readerId', 'identityPolicy', 'taskId', 'citationKey', 'sourceRef', 'materialId', 'idNamespace', 'sha256', 'readAt', 'extractedCharacters']
        .every(key => page[key] === first[key]); end = page.offset + page.content.length; return okay;
    });
    const allPages = contiguous && end === first.extractedCharacters && pages.at(-1).nextCursor === null;
    const verifiedDigest = allPages && digest(text) === first.sha256;
    if (allPages && !verifiedDigest) throw fault('source_content_digest_mismatch');
    return { readId: first.readId, taskId, citationKey: first.citationKey, sourceRef: first.sourceRef, materialId: first.materialId,
      idNamespace: first.idNamespace, sha256: first.sha256, readAt: first.readAt, format: first.format, extractionScope: first.extractionScope,
      pages, allPages, verifiedDigest, complete: verifiedDigest && first.contentComplete === true, trustedInstructions: false, snapshotAtAnswerTime: false };
  });
}
