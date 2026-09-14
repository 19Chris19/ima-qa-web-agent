'use strict';

const DEFAULT_MAX_EVENT_BYTES = 896 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 1024 * 1024;
const MAX_NORMALIZED_SOURCES = 100;
const MAX_SOURCE_TITLE_LENGTH = 512;
const MAX_SOURCE_SNIPPET_LENGTH = 5_000;
const CONTROL_EVENTS = new Set([
  'close',
  'control',
  'heartbeat',
  'ping',
  'qastart',
  'recommendedknowledgebase',
  'sessionstart',
  'suggestquestion',
]);
const SENSITIVE_FIELD = /token|cookie|credential|secret|password|wxid|group.?id/iu;
const OPAQUE_DIAGNOSTIC_FIELDS = new Set(['DebugProfile', 'IntentReportID']);
const REFERENCE_ITEM_KEYS = new Set([
  'content', 'href', 'jumpUrl', 'jump_url', 'kbName', 'kb_name', 'logoUrl', 'logo_url',
  'mediaId', 'media_id', 'name', 'official', 'positions', 'publisher', 'source',
  'sourceType', 'title', 'type', 'url',
]);
const AUXILIARY_SEMANTIC_KEY = /answer|code|complete|content|description|error|message|result|status|summary|terminal|text/iu;

class IMAUpstreamProtocolError extends Error {
  constructor(code, reason = 'protocol_variant_unrecognized', options = {}) {
    super(code);
    this.name = 'IMAUpstreamProtocolError';
    this.code = code;
    this.reason = reason;
    this.completionCodeCategory = options.completionCodeCategory || '';
    this.completionCode = Number.isInteger(options.completionCode)
      ? options.completionCode
      : null;
  }
}

async function* parseIMAWebAgentStream(response, options = {}) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new IMAUpstreamProtocolError('upstream_stream_missing');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const seenSources = new Set();
  const maxEventBytes = positiveLimit(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
  const maxStreamBytes = positiveLimit(options.maxStreamBytes, DEFAULT_MAX_STREAM_BYTES);
  let buffer = '';
  let streamBytes = 0;
  let terminalSeen = false;
  let semanticEventSeen = false;
  let statusNoticeSeen = false;

  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new IMAUpstreamProtocolError('upstream_stream_chunk_invalid');
      }
      streamBytes += chunk.byteLength;
      if (streamBytes > maxStreamBytes) {
        throw new IMAUpstreamProtocolError('upstream_stream_too_large');
      }
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (Buffer.byteLength(block, 'utf8') > maxEventBytes) {
          throw new IMAUpstreamProtocolError('upstream_event_too_large');
        }
        const event = parseIMAWebAgentEvent(block);
        observeEventDescriptor(options.onEventDescriptor, event);
        const result = normalizeIMAWebAgentEvent(event, seenSources, options);
        if (result.type === 'control') {
          if (isProvedStructuredStatusNoticeEvent(event)) {
            if (terminalSeen) {
              throw new IMAUpstreamProtocolError('upstream_event_after_terminal');
            }
            statusNoticeSeen = true;
          }
          boundary = buffer.indexOf('\n\n');
          continue;
        }
        if (terminalSeen) {
          throw new IMAUpstreamProtocolError(
            result.type === 'done' ? 'upstream_terminal_duplicate' : 'upstream_event_after_terminal',
          );
        }
        if (result.type === 'done') {
          if (statusNoticeSeen && !semanticEventSeen) {
            throw new IMAUpstreamProtocolError(
              'upstream_status_notice_without_semantic',
              'protocol_variant_unrecognized',
            );
          }
          terminalSeen = true;
        }
        if ((result.type === 'delta' && Boolean(String(result.text || '')))
            || (result.type === 'sources' && result.sources.length > 0)) {
          semanticEventSeen = true;
        }
        yield result;
        boundary = buffer.indexOf('\n\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxEventBytes) {
        throw new IMAUpstreamProtocolError('upstream_event_too_large');
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error instanceof IMAUpstreamProtocolError) throw error;
    throw new IMAUpstreamProtocolError('upstream_stream_invalid_utf8');
  }

  if (buffer.trim()) {
    if (Buffer.byteLength(buffer, 'utf8') > maxEventBytes) {
      throw new IMAUpstreamProtocolError('upstream_event_too_large');
    }
    const event = parseIMAWebAgentEvent(buffer);
    observeEventDescriptor(options.onEventDescriptor, event);
    const result = normalizeIMAWebAgentEvent(event, seenSources, options);
    if (result.type === 'control') {
      if (isProvedStructuredStatusNoticeEvent(event)) {
        if (terminalSeen) {
          throw new IMAUpstreamProtocolError('upstream_event_after_terminal');
        }
        statusNoticeSeen = true;
      }
    } else {
      if (terminalSeen) {
        throw new IMAUpstreamProtocolError(
          result.type === 'done' ? 'upstream_terminal_duplicate' : 'upstream_event_after_terminal',
        );
      }
      if (result.type === 'done') {
        if (statusNoticeSeen && !semanticEventSeen) {
          throw new IMAUpstreamProtocolError(
            'upstream_status_notice_without_semantic',
            'protocol_variant_unrecognized',
          );
        }
        terminalSeen = true;
      }
      if ((result.type === 'delta' && Boolean(String(result.text || '')))
          || (result.type === 'sources' && result.sources.length > 0)) {
        semanticEventSeen = true;
      }
      yield result;
    }
  }
  if (!terminalSeen) {
    throw new IMAUpstreamProtocolError('upstream_terminal_missing');
  }
}

function observeEventDescriptor(observer, event) {
  if (typeof observer !== 'function') return;
  try {
    observer(describeIMAWebAgentEvent(event));
  } catch {}
}

function observeNormalizationDiagnostic(observer, category) {
  if (typeof observer !== 'function') return;
  try {
    observer(category);
  } catch {}
}

function parseIMAWebAgentEvent(eventBlock) {
  const event = { eventName: 'message', dataText: '' };
  const dataLines = [];
  let explicitEvent = false;
  for (const line of String(eventBlock || '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      if (explicitEvent) throw new IMAUpstreamProtocolError('upstream_event_name_duplicate');
      explicitEvent = true;
      event.eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else if (!line.startsWith('id:') && !line.startsWith('retry:')) {
      throw new IMAUpstreamProtocolError('upstream_sse_field_unsupported');
    }
  }
  if (dataLines.length === 0) {
    if (!explicitEvent) return { eventName: 'control', dataText: '', data: '' };
    throw new IMAUpstreamProtocolError('upstream_event_data_missing');
  }
  event.dataText = dataLines.join('\n');
  if (event.dataText === '[DONE]') {
    event.data = event.dataText;
    return event;
  }
  try {
    event.data = JSON.parse(event.dataText);
  } catch {
    const compactName = String(event.eventName || '').replace(/[_\s-]/gu, '').toLowerCase();
    if (CONTROL_EVENTS.has(compactName)) {
      event.data = event.dataText;
      return event;
    }
    throw new IMAUpstreamProtocolError('upstream_event_json_invalid');
  }
  return event;
}

function normalizeIMAWebAgentEvent(event, seenSources = new Set(), options = {}) {
  const eventFamily = eventFamilyFromName(canonicalEventName(event), event?.data);
  if (eventFamily === 'unknown') {
    observeEventDescriptor(options.onUnknownEventDescriptor, event);
    throw new IMAUpstreamProtocolError('protocol_variant_unrecognized');
  }
  if (eventFamily === 'control') {
    if (isProvedStructuredAuxiliaryIndexBlock(event?.data)) {
      observeNormalizationDiagnostic(
        options.onNormalizationDiagnostic,
        'structured_auxiliary_recovered',
      );
    }
    return { type: 'control' };
  }
  if (eventFamily === 'message') {
    const text = pickMessageChunk(unwrapBlockMessage(event.data));
    if (!text) throw new IMAUpstreamProtocolError('upstream_message_text_missing');
    return { type: 'delta', text };
  }
  if (eventFamily === 'sources') {
    const records = extractSourceRecords(event, seenSources, options);
    const sources = records.map((record) => record.source);
    const sourceKinds = records.map((record) => record.sourceKind);
    const sourceKind = collapseSourceKinds(sourceKinds, event);
    const searchSummary = typeof event.data?.processing === 'string'
      ? event.data.processing
      : '';
    return sources.length > 0 || searchSummary
      ? { type: 'sources', sources, searchSummary, sourceKind, sourceKinds }
      : { type: 'control' };
  }
  const completion = completionCode(event.data);
  const category = classifyCompletionCode(completion);
  if (category !== 'success') {
    throw new IMAUpstreamProtocolError(`upstream_${category}`, `upstream_${category}`, {
      completionCode: completion,
      completionCodeCategory: category,
    });
  }
  return { type: 'done' };
}

function sourceKindFromEvent(event, item) {
  if (item?.sourceType !== undefined && item?.sourceType !== null) {
    const sourceType = Number(item.sourceType);
    if (sourceType === 0) return 'web';
    if (sourceType === 1 || sourceType === 2) return 'knowledge';
    throw new IMAUpstreamProtocolError('upstream_source_kind_unknown');
  }
  const compact = String(canonicalEventName(event) || '')
    .replace(/[_\s-]/gu, '')
    .toLowerCase();
  if (compact === 'contextreferences') return 'web';
  if (compact === 'searchmedias' || compact === 'structuredblock') {
    return 'knowledge';
  }
  throw new IMAUpstreamProtocolError('upstream_source_kind_unknown');
}

function collapseSourceKinds(sourceKinds, event) {
  const kinds = new Set(sourceKinds);
  if (kinds.size === 1) return sourceKinds[0];
  if (kinds.size > 1) return 'mixed';
  return sourceKindFromEvent(event, null);
}

function describeIMAWebAgentEvent(event) {
  const name = canonicalEventName(event);
  const eventFamily = eventFamilyFromName(name, event?.data);
  const recognized = eventFamily !== 'unknown';
  let fieldSignatures = [];
  let signatureFailureCategory = '';
  try {
    fieldSignatures = collectFieldSignatures(event?.data);
  } catch (error) {
    signatureFailureCategory = fixedSignatureFailureCategory(error);
    if (signatureFailureCategory === 'protocol_signature_field_forbidden') {
      fieldSignatures = collectRedactedFieldSignatures(event?.data);
    }
  }
  return Object.freeze({
    eventName: String(event?.eventName || 'message'),
    eventFamily,
    recognized,
    recognitionCategory: recognized ? 'recognized' : 'unrecognized',
    fieldSignatures: Object.freeze(fieldSignatures),
    signatureFailureCategory,
    textLengthBucket: lengthBucket(pickMessageChunk(unwrapBlockMessage(event?.data))),
    structuredBlockSubtype: structuredBlockSubtype(event),
    structuredBlockType: safeStructuredBlockType(event),
    structuredBlockValidationCategory: structuredReferenceIndexesValidationCategory(event?.data),
    structuredBlockPositionCategory: structuredReferencePositionCategory(event?.data),
    completionCategory: eventFamily === 'done'
      ? classifyCompletionCode(completionCode(event?.data))
      : 'not_terminal',
  });
}

function structuredReferencePositionCategory(data) {
  const indexes = data?.Data?.reference_indexes?.indexes;
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) return 'not_positions';
  const positions = Object.values(indexes).map((item) => item?.positions);
  if (positions.some((value) => !Array.isArray(value))) return 'positions_invalid';
  const validationFailure = positions
    .map(validateOpaqueReferencePositions)
    .find((value) => value !== 'positions_valid');
  if (validationFailure) return validationFailure;
  const values = positions.flat();
  if (values.length === 0) return 'positions_empty';
  if (values.length > 10_000) return 'positions_oversized';
  const types = new Set(values.map((value) => (
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  )));
  if (types.size !== 1) return 'positions_mixed';
  const [type] = types;
  if (type === 'number' && values.every(Number.isInteger)) return 'positions_integers';
  if (type === 'string') return 'positions_strings';
  if (type === 'object') return 'positions_objects';
  return 'positions_other';
}

function structuredReferenceIndexesValidationCategory(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || !data.Data?.reference_indexes?.indexes) return 'not_reference_indexes';
  if (!exactKeys(data, ['Data', 'Id', 'Type'])) return 'reference_outer_keys';
  if (!boundedControlString(data.Id, 512)) return 'reference_outer_id';
  if (!boundedControlString(data.Type, 64)) return 'reference_outer_type';
  if (!exactKeys(data.Data, ['reference_indexes'])) return 'reference_data_keys';
  if (!exactKeys(data.Data.reference_indexes, ['indexes'])) return 'reference_container_keys';
  const indexes = data.Data.reference_indexes.indexes;
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) {
    return 'reference_indexes_type';
  }
  const entries = Object.entries(indexes);
  if (entries.length < 1 || entries.length > MAX_NORMALIZED_SOURCES) {
    return 'reference_indexes_count';
  }
  for (const [key, item] of entries) {
    if (!boundedControlString(key, 128)) return 'reference_key';
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'reference_item_type';
    const category = structuredReferenceItemCategory(item);
    if (category === 'valid') continue;
    if (category === 'discardable') return 'reference_item_discardable';
    return 'reference_item_unsafe';
  }
  return 'reference_indexes_valid';
}

function fixedSignatureFailureCategory(error) {
  const code = String(error?.code || '');
  return new Set([
    'protocol_signature_array_exceeded',
    'protocol_signature_depth_exceeded',
    'protocol_signature_field_forbidden',
    'protocol_signature_fields_exceeded',
  ]).has(code) ? code : 'protocol_signature_unknown';
}

function structuredBlockSubtype(event) {
  const name = String(event?.eventName || '').replace(/[_\s-]/gu, '').toLowerCase();
  if (name !== 'structuredblock') return 'not_structured_block';
  const subtype = String(event?.data?.Type || '');
  if (subtype === 'blockMessage') return 'block_message';
  if (subtype === 'emptyContent') return 'empty_content';
  if (isProvedStructuredStatusNoticeBlock(event?.data)) return 'status_notice';
  if (isProvedStructuredReferenceIndexesBlock(event?.data)) return 'reference_indexes';
  if (isProvedStructuredAuxiliaryIndexBlock(event?.data)) return 'auxiliary_index';
  return 'unknown';
}

function safeStructuredBlockType(event) {
  const name = String(event?.eventName || '').replace(/[_\s-]/gu, '').toLowerCase();
  if (name !== 'structuredblock') return 'not_structured_block';
  const token = String(event?.data?.Type || '');
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(token) ? token : 'unavailable';
}

function canonicalEventName(event) {
  const rawName = String(event?.eventName || 'message').trim();
  if (rawName && rawName.toLowerCase() !== 'message') return rawName;
  const data = event?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of ['type', 'event', 'eventName', 'event_name']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim();
    }
    if (data.blockMessage && typeof data.blockMessage === 'object') return 'blockMessage';
    if (data.text_message && typeof data.text_message === 'object') return 'blockMessage';
    if (Number.isInteger(Number(data.Code ?? data.code))) return 'COMPLETED';
  }
  return rawName || 'message';
}

function eventFamilyFromName(value, data) {
  const compact = String(value || '').replace(/[_\s-]/gu, '').toLowerCase();
  if (compact === 'message' && typeof data === 'string' && data === '[DONE]') return 'unknown';
  if (compact === 'structuredblock') {
    if (isProvedStructuredBlockMessage(data)) return 'message';
    if (isProvedStructuredFileListBlock(data)) return 'sources';
    if (isProvedStructuredFileContentBlock(data)) return 'sources';
    if (isProvedStructuredReferenceIndexesBlock(data)) return 'sources';
    if (isProvedStructuredAuxiliaryIndexBlock(data)) return 'control';
    return isProvedEmptyContentBlock(data)
      || isProvedEmptyStructuredEnvelope(data)
      || isProvedStructuredStatusNoticeBlock(data)
      ? 'control'
      : 'unknown';
  }
  if (compact === 'attachedblock') {
    return isProvedAttachedBlock(data) ? 'control' : 'unknown';
  }
  if (compact === 'message' || compact === 'blockmessage') {
    return pickMessageChunk(unwrapBlockMessage(data)) ? 'message' : 'unknown';
  }
  if (compact === 'searchmedias' || compact === 'contextreferences') return 'sources';
  if (compact === 'completed') return 'done';
  if (CONTROL_EVENTS.has(compact)) return 'control';
  return 'unknown';
}

function isProvedEmptyStructuredEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Id', 'Type', 'UpdateType'])) return false;
  if (!data.Data || typeof data.Data !== 'object' || Array.isArray(data.Data)
      || Object.keys(data.Data).length !== 0) return false;
  return boundedControlString(data.Id, 512)
    && boundedControlString(data.Type, 64)
    && boundedControlString(data.UpdateType, 64);
}

function isProvedEmptyContentBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.Type !== 'emptyContent') return false;
  const block = data.Data;
  return Boolean(
    block
    && typeof block === 'object'
    && !Array.isArray(block)
    && typeof block.content === 'string'
    && block.extent_action
    && typeof block.extent_action === 'object'
    && !Array.isArray(block.extent_action),
  );
}

function isProvedStructuredStatusNoticeBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Id', 'Type', 'UpdateType'])) return false;
  if (!boundedControlString(data.Id, 512)
      || !boundedControlString(data.Type, 64)
      || !boundedControlString(data.UpdateType, 64)) return false;
  const block = data.Data;
  if (!block || typeof block !== 'object' || Array.isArray(block)
      || !exactKeys(block, ['status_notice'])) return false;
  const notice = block.status_notice;
  return Boolean(
    notice
    && typeof notice === 'object'
    && !Array.isArray(notice)
    && exactKeys(notice, ['description', 'status', 'tool_id'])
    && boundedOptionalMessageText(notice.description, 2_048)
    && Number.isSafeInteger(notice.status)
    && boundedControlString(notice.tool_id, 512),
  );
}

function isProvedStructuredStatusNoticeEvent(event) {
  return String(event?.eventName || '').replace(/[_\s-]/gu, '').toLowerCase()
    === 'structuredblock'
    && isProvedStructuredStatusNoticeBlock(event?.data);
}

function isProvedStructuredFileListBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Id', 'Type', 'UpdateType'])) return false;
  if (!boundedControlString(data.Id, 512)
      || !boundedControlString(data.Type, 64)
      || !boundedControlString(data.UpdateType, 64)) return false;
  const block = data.Data;
  if (!block || typeof block !== 'object' || Array.isArray(block)
      || !exactKeys(block, ['file_list'])) return false;
  const fileList = block.file_list;
  if (!fileList || typeof fileList !== 'object' || Array.isArray(fileList)
      || !exactKeys(fileList, ['description', 'files', 'status', 'tool_id'])
      || !boundedOptionalString(fileList.description, 2_048)
      || !boundedOptionalString(fileList.tool_id, 512)
      || !Number.isInteger(fileList.status)
      || !Array.isArray(fileList.files)
      || fileList.files.length < 1
      || fileList.files.length > MAX_NORMALIZED_SOURCES) return false;
  return fileList.files.every(isProvedStructuredFileItem);
}

function isProvedStructuredFileContentBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Id', 'Type', 'UpdateType'])) return false;
  if (!boundedControlString(data.Id, 512)
      || !boundedControlString(data.Type, 64)
      || !boundedControlString(data.UpdateType, 64)) return false;
  const block = data.Data;
  if (!block || typeof block !== 'object' || Array.isArray(block)
      || !exactKeys(block, ['file_content'])) return false;
  const content = block.file_content;
  if (!content || typeof content !== 'object' || Array.isArray(content)
      || !exactKeys(content, ['description', 'media', 'status', 'tool_id'])
      || !boundedOptionalString(content.description, 2_048)
      || !boundedOptionalString(content.tool_id, 512)
      || !Number.isInteger(content.status)) return false;
  return isProvedStructuredFileItem(content.media);
}

function isProvedStructuredFileItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (exactKeys(item, ['id', 'logo', 'sourceType', 'title', 'type'])) {
    return boundedControlString(item.id, 2_048)
      && boundedOptionalString(item.logo, 8_192)
      && boundedControlString(item.title, MAX_SOURCE_TITLE_LENGTH)
      && [0, 1, 2].includes(item.sourceType)
      && Number.isInteger(item.type);
  }
  if (exactKeys(item, ['jumpUrl', 'logo', 'title', 'type'])) {
    return boundedControlString(item.jumpUrl, 8_192)
      && boundedOptionalString(item.logo, 8_192)
      && boundedControlString(item.title, MAX_SOURCE_TITLE_LENGTH)
      && Number.isInteger(item.type);
  }
  return false;
}

function isProvedStructuredBlockMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Id', 'Type']) || data.Type !== 'blockMessage') return false;
  if (!boundedControlString(data.Id, 512)) return false;
  const block = data.Data;
  if (!block || typeof block !== 'object' || Array.isArray(block)
      || !exactKeys(block, ['text_message'])) return false;
  const message = block.text_message;
  return Boolean(
    message
    && typeof message === 'object'
    && !Array.isArray(message)
    && exactKeys(message, ['Text'])
    && boundedMessageText(message.Text, DEFAULT_MAX_EVENT_BYTES),
  );
}

function isProvedStructuredReferenceIndexesBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Id', 'Type'])
      || !boundedControlString(data.Id, 512)
      || !boundedControlString(data.Type, 64)) return false;
  const outer = data.Data;
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)
      || !exactKeys(outer, ['reference_indexes'])) return false;
  const references = outer.reference_indexes;
  if (!references || typeof references !== 'object' || Array.isArray(references)
      || !exactKeys(references, ['indexes'])) return false;
  const indexes = references.indexes;
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) return false;
  const entries = Object.entries(indexes);
  if (entries.length < 1 || entries.length > MAX_NORMALIZED_SOURCES) return false;
  return entries.every(([key, item]) => Boolean(
    boundedControlString(key, 128) && structuredReferenceItemCategory(item) !== 'unsafe'
  ));
}

function isProvedStructuredReferenceItem(item) {
  return structuredReferenceItemCategory(item) === 'valid';
}

function structuredReferenceItemCategory(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'unsafe';
  const keys = Object.keys(item);
  if (keys.length < 1 || keys.length > 32 || keys.some((key) => !REFERENCE_ITEM_KEYS.has(key))) {
    return 'unsafe';
  }
  const identity = item.media_id ?? item.mediaId ?? item.jump_url ?? item.jumpUrl
    ?? item.url ?? item.href;
  if (identity !== undefined && !boundedOptionalString(identity, 8_192)) return 'discardable';
  if (identity === undefined && !boundedOptionalString(item.source ?? '', 2_048)) {
    return 'discardable';
  }
  for (const value of [item.title, item.name, item.kb_name, item.kbName]) {
    if (value !== undefined && !boundedOptionalString(value, MAX_SOURCE_TITLE_LENGTH)) {
      return 'discardable';
    }
  }
  for (const value of [item.logo_url, item.logoUrl]) {
    if (value !== undefined && !boundedOptionalString(value, 8_192)) return 'discardable';
  }
  for (const value of [item.source, item.publisher]) {
    if (value !== undefined && !boundedOptionalString(value, 2_048)) return 'discardable';
  }
  if (item.content !== undefined
      && !boundedOptionalMessageText(item.content, DEFAULT_MAX_EVENT_BYTES)) {
    return 'discardable';
  }
  if (item.positions !== undefined && !boundedOpaqueReferencePositions(item.positions)) {
    return 'discardable';
  }
  if (item.type !== undefined && !Number.isInteger(item.type)) return 'discardable';
  if (item.sourceType !== undefined && ![0, 1, 2].includes(item.sourceType)) {
    return 'discardable';
  }
  if (item.official !== undefined && typeof item.official !== 'boolean') return 'discardable';
  return 'valid';
}

function isProvedStructuredAuxiliaryIndexBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const outerKeys = Object.keys(data);
  if (!outerKeys.every((key) => ['Data', 'Id', 'Type', 'UpdateType'].includes(key))
      || !outerKeys.includes('Data')
      || !outerKeys.includes('Id')
      || !outerKeys.includes('Type')
      || !boundedControlString(data.Id, 512)
      || !boundedControlString(data.Type, 64)
      || (data.UpdateType !== undefined && !boundedControlString(data.UpdateType, 64))) {
    return false;
  }
  const containers = data.Data;
  if (!containers || typeof containers !== 'object' || Array.isArray(containers)
      || Object.keys(containers).length !== 1) return false;
  const [containerKey] = Object.keys(containers);
  if (!boundedControlString(containerKey, 128) || AUXILIARY_SEMANTIC_KEY.test(containerKey)) {
    return false;
  }
  const container = containers[containerKey];
  if (!container || typeof container !== 'object' || Array.isArray(container)
      || !exactKeys(container, ['indexes'])) return false;
  const indexes = container.indexes;
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) return false;
  const entries = Object.entries(indexes);
  if (entries.length < 1 || entries.length > MAX_NORMALIZED_SOURCES) return false;
  return entries.every(([key, item]) => (
    boundedControlString(key, 128) && isProvedAuxiliaryIndexItem(item)
  ));
}

function isProvedAuxiliaryIndexItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const keys = Object.keys(item);
  if (keys.length < 1 || keys.length > 16) return false;
  let hasUrl = false;
  for (const key of keys) {
    if (!boundedControlString(key, 128)
        || ['__proto__', 'constructor', 'prototype'].includes(key)
        || AUXILIARY_SEMANTIC_KEY.test(key)) return false;
    const value = item[key];
    if (key === 'url') {
      if (!boundedControlString(value, 8_192)) return false;
      hasUrl = true;
      continue;
    }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value === 'string' && boundedOptionalString(value, 2_048)) continue;
    return false;
  }
  return hasUrl;
}

function isProvedAttachedBlock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!exactKeys(data, ['Data', 'Type', 'UpdateType'])) return false;
  if (!boundedControlString(data.Type, 64) || !boundedControlString(data.UpdateType, 64)) {
    return false;
  }
  const block = data.Data;
  return Boolean(
    block
    && typeof block === 'object'
    && !Array.isArray(block)
    && exactKeys(block, ['download_channel'])
    && boundedControlString(block.download_channel, 2_048),
  );
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function boundedControlString(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedOptionalString(value, maxLength) {
  return typeof value === 'string'
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedMessageText(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function boundedOptionalMessageText(value, maxLength) {
  return typeof value === 'string'
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function boundedOpaqueReferencePositions(value) {
  return validateOpaqueReferencePositions(value) === 'positions_valid';
}

function validateOpaqueReferencePositions(value) {
  if (!Array.isArray(value)) return 'positions_invalid';
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return 'positions_not_json'; }
  if (Buffer.byteLength(encoded, 'utf8') > 512 * 1024) return 'positions_bytes_exceeded';
  let visited = 0;
  let failure = '';
  const visit = (item, depth) => {
    visited += 1;
    if (visited > 100_000) {
      failure ||= 'positions_nodes_exceeded';
      return false;
    }
    if (depth > 16) {
      failure ||= 'positions_depth_exceeded';
      return false;
    }
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) failure ||= 'positions_number_invalid';
      return Number.isFinite(item);
    }
    if (typeof item === 'string') {
      if (!boundedOptionalMessageText(item, 8_192)) failure ||= 'positions_string_invalid';
      return boundedOptionalMessageText(item, 8_192);
    }
    if (Array.isArray(item)) {
      if (item.length > 10_000) {
        failure ||= 'positions_array_exceeded';
        return false;
      }
      return item.every((entry) => visit(entry, depth + 1));
    }
    if (!item || typeof item !== 'object') {
      failure ||= 'positions_type_invalid';
      return false;
    }
    const keys = Object.keys(item);
    if (keys.length > 128) {
      failure ||= 'positions_keys_exceeded';
      return false;
    }
    return keys.every((key) => (
      (() => {
        if (!boundedOptionalString(key, 512) || key.length === 0) {
          failure ||= 'positions_key_invalid';
          return false;
        }
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          failure ||= 'positions_key_forbidden';
          return false;
        }
        return visit(item[key], depth + 1);
      })()
    ));
  };
  return visit(value, 0) ? 'positions_valid' : (failure || 'positions_invalid');
}

function unwrapBlockMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (isProvedStructuredBlockMessage(data)) return data.Data;
  return data.blockMessage && typeof data.blockMessage === 'object'
    ? data.blockMessage
    : data;
}

function pickMessageChunk(data) {
  if (typeof data === 'string') return data === '[DONE]' ? '' : data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  if (data.text_message && typeof data.text_message === 'object') {
    return typeof data.text_message.Text === 'string' ? data.text_message.Text : '';
  }
  for (const key of ['Text', 'text', 'content', 'Content', 'message', 'Message']) {
    if (typeof data[key] === 'string') return data[key];
  }
  return '';
}

function extractSourceRecords(event, seenSources, options = {}) {
  const data = event?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const items = []
    .concat(Array.isArray(data.medias) ? data.medias : [])
    .concat(Array.isArray(data.Medias) ? data.Medias : [])
    .concat(Array.isArray(data.references) ? data.references : [])
    .concat(Array.isArray(data.items) ? data.items : [])
    .concat(isProvedStructuredFileListBlock(data) ? data.Data.file_list.files : [])
    .concat(isProvedStructuredFileContentBlock(data) ? [data.Data.file_content.media] : [])
    .concat(isProvedStructuredReferenceIndexesBlock(data)
      ? Object.entries(data.Data.reference_indexes.indexes)
        .map(([referenceKey, item]) => ({ referenceKey, item }))
      : []);
  const records = [];
  for (const candidate of items) {
    if (seenSources.size >= MAX_NORMALIZED_SOURCES) break;
    const referenceCandidate = candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && Object.prototype.hasOwnProperty.call(candidate, 'referenceKey')
      && Object.prototype.hasOwnProperty.call(candidate, 'item');
    const item = referenceCandidate ? candidate.item : candidate;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (referenceCandidate && structuredReferenceItemCategory(item) !== 'valid') {
      observeNormalizationDiagnostic(options.onNormalizationDiagnostic, 'source_item_discarded');
      continue;
    }
    const rawTitle = String(item.title || item.name || '未命名资料').trim();
    const rawSnippet = String(
      item.publisher || item.knowledgeBaseInfo?.name || item.content
        || item.kb_name || item.kbName || '',
    ).trim();
    if (Array.from(rawSnippet).length > MAX_SOURCE_SNIPPET_LENGTH) {
      observeNormalizationDiagnostic(
        options.onNormalizationDiagnostic,
        'source_snippet_truncated',
      );
    }
    const title = normalizeSourceText(rawTitle, MAX_SOURCE_TITLE_LENGTH, '未命名资料');
    const snippet = normalizeSourceText(rawSnippet, MAX_SOURCE_SNIPPET_LENGTH);
    const sourceKey = String(
      item.id
        || item.media_id
        || item.mediaId
        || item.url
        || item.href
        || item.jumpUrl
        || item.jump_url
        || (referenceCandidate ? `reference:${candidate.referenceKey}` : '')
        || (title || snippet ? `content:${title}\u0000${snippet}` : ''),
    ).trim();
    if (!sourceKey || seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    records.push({
      source: {
        index: seenSources.size,
        title,
        snippet,
      },
      sourceKind: classifySourceKind(options.sourceClassifier, event, item),
    });
  }
  return records;
}

function classifySourceKind(classifier, event, item) {
  if (typeof classifier !== 'function') return sourceKindFromEvent(event, item);
  let result;
  try {
    result = classifier(item, event);
  } catch {
    throw new IMAUpstreamProtocolError('upstream_source_proof_failed');
  }
  if (!['knowledge', 'web', 'unknown'].includes(result)) {
    throw new IMAUpstreamProtocolError('upstream_source_proof_invalid');
  }
  return result;
}

function normalizeSourceText(value, maxLength, fallback = '') {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .trim();
  const input = cleaned || fallback;
  let output = '';
  for (const character of input) {
    if (output.length + character.length > maxLength) break;
    output += character;
  }
  return output || fallback;
}

function extractSources(data, seenSources) {
  return extractSourceRecords({ eventName: 'SEARCH_MEDIAS', data }, seenSources)
    .map((record) => record.source);
}

function completionCode(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return NaN;
  const value = data.Code ?? data.code;
  return Number.isInteger(Number(value)) ? Number(value) : NaN;
}

function classifyCompletionCode(code) {
  if (!Number.isInteger(code)) return 'terminal_unknown';
  if (code === 0) return 'success';
  if (code === 3) return 'temporary';
  if (code === 1_000) return 'bad_request';
  if ([41, 401, 403, 1_100, 1_101, 600_001].includes(code)) return 'auth';
  if ([429, 1_301, 200_005].includes(code)) return 'quota';
  if ([1_400, 1_402, 300_001].includes(code)) return 'upstream_service';
  if (code >= 400 && code < 500) return 'rejected';
  return 'terminal_unknown';
}

function collectFieldSignatures(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  if (depth > 4) throw new IMAUpstreamProtocolError('protocol_signature_depth_exceeded');
  const signatures = [];
  const keys = Object.keys(value).sort();
  if (keys.length > 64) throw new IMAUpstreamProtocolError('protocol_signature_fields_exceeded');
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || SENSITIVE_FIELD.test(key)) {
      throw new IMAUpstreamProtocolError('protocol_signature_field_forbidden');
    }
    const path = prefix ? `${prefix}.${key}` : key;
    const item = value[key];
    const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    signatures.push(`${path}:${type}`);
    if (type === 'object' && !OPAQUE_DIAGNOSTIC_FIELDS.has(key)) {
      signatures.push(...collectFieldSignatures(item, path, depth + 1));
    } else if (type === 'array' && item.length > 0) {
      if (item.length > MAX_NORMALIZED_SOURCES) {
        throw new IMAUpstreamProtocolError('protocol_signature_array_exceeded');
      }
      const itemSignatures = new Set();
      for (const element of item) {
        if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
        for (const signature of collectFieldSignatures(element, `${path}[]`, depth + 1)) {
          itemSignatures.add(signature);
        }
      }
      signatures.push(...[...itemSignatures].sort());
    }
  }
  return signatures;
}

function collectRedactedFieldSignatures(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return [];
  const signatures = [];
  for (const key of Object.keys(value).sort().slice(0, 64)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || SENSITIVE_FIELD.test(key)) {
      const redactedItem = value[key];
      const redactedType = redactedItem === null
        ? 'null'
        : Array.isArray(redactedItem) ? 'array' : typeof redactedItem;
      const redactedPath = `${prefix ? `${prefix}.` : ''}[redacted]`;
      signatures.push(`${redactedPath}:${redactedType}`);
      if (redactedType === 'object') {
        signatures.push(...collectRedactedFieldSignatures(redactedItem, redactedPath, depth + 1));
      }
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    const item = value[key];
    const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    signatures.push(`${path}:${type}`);
    if (type === 'object' && !OPAQUE_DIAGNOSTIC_FIELDS.has(key)) {
      signatures.push(...collectRedactedFieldSignatures(item, path, depth + 1));
    } else if (type === 'array' && item.length > 0) {
      const nested = new Set();
      for (const element of item.slice(0, MAX_NORMALIZED_SOURCES)) {
        if (element && typeof element === 'object' && !Array.isArray(element)) {
          for (const signature of collectRedactedFieldSignatures(
            element,
            `${path}[]`,
            depth + 1,
          )) {
            nested.add(signature);
          }
        } else {
          const elementType = element === null
            ? 'null'
            : Array.isArray(element) ? 'array' : typeof element;
          nested.add(`${path}[]:${elementType}`);
        }
      }
      if (item.length > MAX_NORMALIZED_SOURCES) nested.add(`${path}[]:truncated`);
      signatures.push(...[...nested].sort());
    }
  }
  return signatures;
}

function lengthBucket(value) {
  const length = Array.from(String(value || '')).length;
  if (length === 0) return '0';
  if (length <= 32) return '1-32';
  if (length <= 128) return '33-128';
  if (length <= 512) return '129-512';
  return '513+';
}

function positiveLimit(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new IMAUpstreamProtocolError('upstream_limit_invalid');
  }
  return number;
}

module.exports = {
  IMAUpstreamProtocolError,
  classifyCompletionCode,
  describeIMAWebAgentEvent,
  extractSources,
  mapIMAWebAgentEvent: normalizeIMAWebAgentEvent,
  normalizeIMAWebAgentEvent,
  parseIMAWebAgentEvent,
  parseIMAWebAgentStream,
  pickMessageChunk,
};
