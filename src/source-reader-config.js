'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./knowledge-evidence');
const invalid = () => Object.assign(new Error('invalid_source_reader_config'), { code: 'invalid_source_reader_config' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f]/u.test(value);
function validate(value = { schemaVersion: 1, readers: [] }) {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.readers) || value.readers.length > 8
    || Object.keys(value).some(key => !['schemaVersion', 'readers', 'pdfEnabled'].includes(key))
    || (value.pdfEnabled !== undefined && typeof value.pdfEnabled !== 'boolean')) throw invalid();
  // The existing PDF dependency exceeded the measured 64MiB extra-RSS gate.
  // Keep the public read path disabled until a separate resource acceptance passes.
  if (value.pdfEnabled === true) throw invalid();
  const ids = new Set();
  const readers = value.readers.map(reader => {
    if (!object(reader) || !id(reader.id) || ids.has(reader.id) || typeof reader.scopeRef !== 'string' || !/^[a-f0-9]{64}$/u.test(reader.scopeRef)
      || !text(reader.clientId) || !text(reader.apiKey) || reader.idNamespace !== 'ima_web_media'
      || !Array.isArray(reader.applications) || !reader.applications.length || reader.applications.length > 64
      || new Set(reader.applications).size !== reader.applications.length || reader.applications.some(app => !id(app))
      || Object.keys(reader).some(key => !['id', 'scopeRef', 'applications', 'clientId', 'apiKey', 'idNamespace', 'identity'].includes(key))) throw invalid();
    ids.add(reader.id);
    const identity = reader.identity;
    if (!object(identity) || !['explicit_bindings', 'verified_passthrough'].includes(identity.mode)
      || Object.keys(identity).some(key => !['mode', 'bindings', 'verificationReference'].includes(key))) throw invalid();
    const bindings = {};
    if (identity.mode === 'explicit_bindings') {
      if (!object(identity.bindings) || Object.keys(identity.bindings).length > 200 || identity.verificationReference !== undefined) throw invalid();
      for (const [native, api] of Object.entries(identity.bindings)) {
        if (!text(native) || !text(api) || ['__proto__', 'constructor', 'prototype'].includes(native)) throw invalid();
        bindings[native] = api;
      }
    } else if (typeof identity.verificationReference !== 'string' || !identity.verificationReference.trim()
      || identity.verificationReference.length > 2048 || /[\u0000-\u001f\u007f]/u.test(identity.verificationReference) || identity.bindings !== undefined) throw invalid();
    return { id: reader.id, scopeRef: reader.scopeRef, applications: [...reader.applications], clientId: reader.clientId, apiKey: reader.apiKey,
      idNamespace: reader.idNamespace, identity: { mode: identity.mode, bindings,
        ...(identity.verificationReference ? { verificationReference: identity.verificationReference } : {}) } };
  });
  // An application/scope can have exactly one authoritative reader identity.
  const pairs = new Set();
  for (const reader of readers) for (const app of reader.applications) {
    const pair = app + ':' + reader.scopeRef;
    if (pairs.has(pair)) throw invalid(); pairs.add(pair);
  }
  return { schemaVersion: 1, readers, pdfEnabled: value.pdfEnabled === true };
}
function fromFile(file) {
  if (!file) return validate();
  let fd;
  try {
    const directory = fs.lstatSync(path.dirname(path.resolve(file)));
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (process.platform !== 'win32' && ((directory.mode & 0o077) || directory.uid !== process.getuid()))) throw invalid();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw invalid();
    return validate(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } catch { throw invalid(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function materialId(reader, material) {
  if (material.idNamespace !== reader.idNamespace) return '';
  return reader.identity.mode === 'verified_passthrough' ? material.materialId : reader.identity.bindings[material.materialId] || '';
}
const fingerprint = reader => hash(JSON.stringify(reader));
module.exports = { validate, fromFile, materialId, fingerprint };
