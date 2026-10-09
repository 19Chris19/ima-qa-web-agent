'use strict';

// Public diagnostics are a fixed vocabulary, never upstream messages or arbitrary codes.
const SAFE_FAILURES = new Set([
  'upstream_headers_timeout', 'upstream_idle_timeout', 'upstream_buffer_limit',
  'upstream_connection_interrupted', 'upstream_terminal_missing', 'upstream_terminal_duplicate',
  'upstream_empty_answer', 'upstream_event_after_terminal', 'upstream_stream_missing',
  'upstream_stream_chunk_invalid', 'upstream_stream_too_large', 'upstream_event_too_large',
  'upstream_stream_invalid_utf8', 'upstream_event_name_duplicate', 'upstream_sse_field_unsupported',
  'upstream_event_data_missing', 'upstream_event_json_invalid', 'upstream_message_text_missing',
  'upstream_source_kind_unknown', 'upstream_source_proof_failed', 'upstream_source_proof_invalid',
  'upstream_status_notice_without_semantic', 'protocol_variant_unrecognized',
  'upstream_auth', 'upstream_quota', 'upstream_temporary', 'upstream_bad_request',
  'upstream_upstream_service', 'upstream_rejected', 'upstream_terminal_unknown', 'upstream_failed',
  'protocol_signature_depth_exceeded', 'protocol_signature_fields_exceeded',
  'protocol_signature_field_forbidden', 'protocol_signature_array_exceeded', 'upstream_limit_invalid',
  'task_capacity', 'timeout', 'openapi_quota_exceeded', 'local_rag_index_missing',
]);

function safeTaskFailureReason(code, fallback = 'upstream_failed') {
  return SAFE_FAILURES.has(code) ? code : fallback;
}

module.exports = { safeTaskFailureReason };
