'use strict';

const { createHmac, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 3;
// Process-local only: permits incident correlation without leaving a key that
// could be used to dictionary-match low-entropy names after restart.
const DIAGNOSTIC_DIGEST_KEY = randomBytes(32);
const MAX_FIELD_SIGNATURES = 128;
const MAX_TOKEN_LENGTH = 128;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const SENSITIVE_FIELD = /token|cookie|credential|secret|password|wxid|group.?id/iu;
const SIGNATURE_TYPES = new Set([
  'array', 'bigint', 'boolean', 'function', 'null', 'number', 'object', 'string',
  'symbol', 'truncated', 'undefined',
]);
const KNOWN_EVENT_NAMES = new Map([
  ['attachedblock', 'attached_block'],
  ['blockmessage', 'block_message'],
  ['close', 'close'],
  ['completed', 'completed'],
  ['contextreferences', 'context_references'],
  ['control', 'control'],
  ['heartbeat', 'heartbeat'],
  ['message', 'message'],
  ['ping', 'ping'],
  ['qastart', 'qa_start'],
  ['recommendedknowledgebase', 'recommended_knowledge_base'],
  ['searchmedias', 'search_medias'],
  ['sessionstart', 'session_start'],
  ['structuredblock', 'structured_block'],
  ['suggestquestion', 'suggest_question'],
]);
const KNOWN_FIELD_SEGMENTS = new Set([
  'Code', 'Content', 'Data', 'Id', 'Medias', 'Message', 'Text', 'Type', 'UpdateType',
  'blockMessage', 'code', 'content', 'description', 'download_channel', 'event',
  'eventName', 'event_name', 'extent_action', 'file_content', 'file_list', 'files',
  'href', 'id', 'indexes', 'items', 'jumpUrl', 'jump_url', 'kb_name',
  'knowledgeBaseInfo', 'logo', 'logo_url', 'media', 'mediaId', 'media_id', 'medias',
  'message', 'name', 'positions', 'processing', 'publisher', 'reference_indexes',
  'references', 'source', 'sourceType', 'status', 'status_notice', 'text',
  'text_message', 'title', 'tool_id', 'type', 'url',
]);
const ALLOWED_ERROR_CODES = new Set([
  'protocol_signature_array_exceeded',
  'protocol_signature_depth_exceeded',
  'protocol_signature_field_forbidden',
  'protocol_signature_fields_exceeded',
  'protocol_variant_unrecognized',
  'upstream_answer_sanitized_empty',
  'upstream_auth',
  'upstream_event_after_terminal',
  'upstream_event_data_missing',
  'upstream_event_json_invalid',
  'upstream_event_name_duplicate',
  'upstream_event_too_large',
  'upstream_limit_invalid',
  'upstream_message_text_missing',
  'upstream_quota',
  'upstream_rejected',
  'upstream_source_kind_unknown',
  'upstream_source_proof_failed',
  'upstream_source_proof_invalid',
  'upstream_sources_without_answer',
  'upstream_sse_field_unsupported',
  'upstream_stream_chunk_invalid',
  'upstream_stream_invalid_utf8',
  'upstream_stream_missing',
  'upstream_stream_too_large',
  'upstream_status_notice_without_semantic',
  'upstream_temporary',
  'upstream_terminal_duplicate',
  'upstream_terminal_missing',
  'upstream_terminal_unknown',
]);
const ALLOWED_NORMALIZATION_CATEGORIES = new Set([
  'source_item_discarded',
  'source_snippet_truncated',
  'structured_auxiliary_recovered',
]);

class ProtocolDiagnosticRecorder {
  constructor({
    filePath,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!path.isAbsolute(String(filePath || ''))
        || String(filePath).length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(String(filePath))) {
      throw new TypeError('protocol_diagnostic_path_invalid');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 16 * 1024 * 1024) {
      throw new TypeError('protocol_diagnostic_max_bytes_invalid');
    }
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10) {
      throw new TypeError('protocol_diagnostic_max_files_invalid');
    }
    if (typeof clock !== 'function') throw new TypeError('protocol_diagnostic_clock_invalid');
    this.filePath = path.resolve(filePath);
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.clock = clock;
    assertSecureDirectory(path.dirname(this.filePath));
    assertOptionalOwnerOnlyFile(this.filePath);
  }

  observe(descriptor) {
    try {
      const sanitized = sanitizeDescriptor(descriptor);
      if (!sanitized || sanitized.recognized !== false) return false;
      const inferredError = inferredErrorCode(sanitized);
      return this._append({
        schema_version: 'ima.upstream.protocol-diagnostic.v1',
        observed_at: this.clock(),
        kind: 'event_descriptor',
        descriptor: sanitized,
        ...(inferredError ? { error_code: inferredError } : {}),
      });
    } catch {
      return false;
    }
  }

  recordError(errorCode) {
    try {
      const safeCode = allowlistedErrorCode(errorCode);
      if (!safeCode) return false;
      return this._append({
        schema_version: 'ima.upstream.protocol-diagnostic.v1',
        observed_at: this.clock(),
        kind: 'error_code',
        error_code: safeCode,
      });
    } catch {
      return false;
    }
  }

  recordNormalization(category) {
    try {
      const safeCategory = allowlistedNormalizationCategory(category);
      if (!safeCategory) return false;
      return this._append({
        schema_version: 'ima.upstream.protocol-diagnostic.v1',
        observed_at: this.clock(),
        kind: 'normalization_category',
        normalization_category: safeCategory,
      });
    } catch {
      return false;
    }
  }

  _append(record) {
    try {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > this.maxBytes) return false;
      assertSecureDirectory(path.dirname(this.filePath));
      const currentSize = regularFileSize(this.filePath);
      if (currentSize > 0 && currentSize + bytes > this.maxBytes) this._rotate();
      appendOwnerOnly(this.filePath, line);
      return true;
    } catch {
      return false;
    }
  }

  _rotate() {
    if (this.maxFiles === 1) {
      safeUnlinkRegular(this.filePath);
      return;
    }
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const target = `${this.filePath}.${index}`;
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      safeUnlinkRegular(target);
      if (!fs.existsSync(source)) continue;
      assertOwnerOnlyRegularFile(source);
      fs.renameSync(source, target);
      fs.chmodSync(target, 0o600);
    }
  }
}

function sanitizeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
  return Object.freeze({
    event_name: sanitizeEventName(descriptor.eventName),
    event_family: safeToken(descriptor.eventFamily),
    recognized: descriptor.recognized === true,
    recognition_category: safeToken(descriptor.recognitionCategory),
    field_signatures: Object.freeze(sanitizeFieldSignatures(descriptor.fieldSignatures)),
    signature_failure_category: safeOptionalToken(descriptor.signatureFailureCategory),
    text_length_bucket: safeToken(descriptor.textLengthBucket),
    structured_block_subtype: safeToken(descriptor.structuredBlockSubtype),
    structured_block_type: safeToken(descriptor.structuredBlockType),
    structured_block_validation_category: safeToken(
      descriptor.structuredBlockValidationCategory,
    ),
    structured_block_position_category: safeToken(
      descriptor.structuredBlockPositionCategory,
    ),
    completion_category: safeToken(descriptor.completionCategory),
  });
}

function sanitizeFieldSignatures(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .slice(0, MAX_FIELD_SIGNATURES)
    .map(sanitizeFieldSignature)
    .filter(Boolean))]
    .sort();
}

function sanitizeEventName(value) {
  const token = String(value || '').slice(0, MAX_TOKEN_LENGTH);
  const compact = token.replace(/[_\s-]/gu, '').toLowerCase();
  if (KNOWN_EVENT_NAMES.has(compact)) return KNOWN_EVENT_NAMES.get(compact);
  return token ? `unknown_${stableDigest(token)}` : 'missing';
}

function sanitizeFieldSignature(value) {
  const signature = String(value || '');
  const separator = signature.lastIndexOf(':');
  if (separator <= 0) return '';
  const rawPath = signature.slice(0, separator);
  const type = signature.slice(separator + 1);
  if (!SIGNATURE_TYPES.has(type) || rawPath.length > 1_024 || SENSITIVE_FIELD.test(rawPath)) {
    return '';
  }
  const segments = rawPath.split('.');
  if (segments.length > 16) return '';
  const safeSegments = [];
  for (const rawSegment of segments) {
    const isArray = rawSegment.endsWith('[]');
    const segment = isArray ? rawSegment.slice(0, -2) : rawSegment;
    if (!segment || segment === '[redacted]' || SENSITIVE_FIELD.test(segment)) {
      safeSegments.push(`redacted${isArray ? '[]' : ''}`);
      continue;
    }
    const safeSegment = KNOWN_FIELD_SEGMENTS.has(segment)
      ? segment
      : `field_${stableDigest(segment)}`;
    safeSegments.push(`${safeSegment}${isArray ? '[]' : ''}`);
  }
  return `${safeSegments.join('.')}:${type}`;
}

function stableDigest(value) {
  return createHmac('sha256', DIAGNOSTIC_DIGEST_KEY)
    .update(String(value), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function safeToken(value) {
  const token = String(value || '').slice(0, MAX_TOKEN_LENGTH);
  return SAFE_TOKEN.test(token) && !SENSITIVE_FIELD.test(token) ? token : 'redacted';
}

function safeOptionalToken(value) {
  if (!value) return '';
  return safeToken(value);
}

function allowlistedErrorCode(value) {
  const code = String(value || '');
  return ALLOWED_ERROR_CODES.has(code) ? code : '';
}

function allowlistedNormalizationCategory(value) {
  const category = String(value || '');
  return ALLOWED_NORMALIZATION_CATEGORIES.has(category) ? category : '';
}

function inferredErrorCode(descriptor) {
  if (descriptor.recognized === false) return 'protocol_variant_unrecognized';
  const completionCodes = {
    auth: 'upstream_auth',
    quota: 'upstream_quota',
    rejected: 'upstream_rejected',
    temporary: 'upstream_temporary',
    terminal_unknown: 'upstream_terminal_unknown',
  };
  return completionCodes[descriptor.completion_category] || '';
}

function regularFileSize(filePath) {
  const status = lstatOptional(filePath);
  if (!status) return 0;
  return assertOwnerOnlyRegularFile(filePath, status).size;
}

function assertOwnerOnlyRegularFile(filePath, knownStatus = null) {
  const status = knownStatus || fs.lstatSync(filePath);
  if (!status.isFile() || status.isSymbolicLink()
      || status.uid !== currentUid()
      || (status.mode & 0o777) !== 0o600) {
    throw new TypeError('protocol_diagnostic_target_invalid');
  }
  return status;
}

function assertOptionalOwnerOnlyFile(filePath) {
  const status = lstatOptional(filePath);
  if (!status) return;
  assertOwnerOnlyRegularFile(filePath, status);
}

function assertSecureDirectory(directoryPath) {
  const resolved = path.resolve(directoryPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let status;
    try {
      status = fs.lstatSync(cursor);
    } catch {
      throw new TypeError('protocol_diagnostic_directory_missing');
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new TypeError('protocol_diagnostic_directory_invalid');
    }
  }
  const directory = fs.lstatSync(resolved);
  if (directory.uid !== currentUid() || (directory.mode & 0o777) !== 0o700) {
    throw new TypeError('protocol_diagnostic_directory_insecure');
  }
}

function currentUid() {
  if (typeof process.getuid !== 'function') {
    throw new TypeError('protocol_diagnostic_uid_unavailable');
  }
  return process.getuid();
}

function safeUnlinkRegular(filePath) {
  const status = lstatOptional(filePath);
  if (!status) return;
  assertOwnerOnlyRegularFile(filePath, status);
  fs.unlinkSync(filePath);
}

function lstatOptional(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function appendOwnerOnly(filePath, line) {
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_APPEND
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(filePath, flags, 0o600);
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.uid !== currentUid()) {
      throw new TypeError('protocol_diagnostic_target_invalid');
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, line, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  ProtocolDiagnosticRecorder,
  allowlistedErrorCode,
  allowlistedNormalizationCategory,
  sanitizeDescriptor,
};
