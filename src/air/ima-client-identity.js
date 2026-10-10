'use strict';

const IMA_CLIENT_IDENTITY_FIELDS = Object.freeze([
  'IMA-GUID',
  'IMA-Q36',
  'IMA-IUA',
  'PLATFORM',
  'CLIENT-TYPE',
  'WEB-VERSION',
]);

const FIELD_LIMITS = Object.freeze({
  'IMA-GUID': 128,
  'IMA-Q36': 128,
  'IMA-IUA': 512,
  PLATFORM: 16,
  'CLIENT-TYPE': 32,
  'WEB-VERSION': 32,
});

function extractImaClientIdentity(cookieHeader) {
  const cookie = parseCookieHeader(cookieHeader);
  const identity = {};
  for (const field of IMA_CLIENT_IDENTITY_FIELDS) {
    const value = boundedCookieValue(cookie[field], field);
    if (value) identity[field] = value;
  }
  return Object.freeze(identity);
}

function requireImaClientIdentity(value) {
  const identity = typeof value === 'string' ? extractImaClientIdentity(value) : value;
  if (
    !identity
    || typeof identity !== 'object'
    || IMA_CLIENT_IDENTITY_FIELDS.some((field) => !boundedCookieValue(identity[field], field))
  ) {
    throw new TypeError('ima_client_identity_incomplete');
  }
  return Object.freeze(Object.fromEntries(
    IMA_CLIENT_IDENTITY_FIELDS.map((field) => [field, boundedCookieValue(identity[field], field)]),
  ));
}

function mergeImaClientIdentity(cookieHeader, value) {
  const cookie = parseCookieHeader(cookieHeader);
  const identity = requireImaClientIdentity(value);
  for (const field of IMA_CLIENT_IDENTITY_FIELDS) cookie[field] = identity[field];
  return stringifyCookie(cookie);
}

function summarizeImaClientIdentity(value) {
  let complete = false;
  try {
    requireImaClientIdentity(value);
    complete = true;
  } catch {
    complete = false;
  }
  return Object.freeze({
    schema_version: 'ima.client-identity.summary.v1',
    complete,
    field_count: complete ? IMA_CLIENT_IDENTITY_FIELDS.length : 0,
  });
}

function observeImaClientIdentity(context) {
  let captured = Object.freeze({});
  const onRequest = (request) => {
    try {
      const url = String(request?.url?.() || '');
      if (!url.startsWith('https://ima.qq.com/cgi-bin/')) return;
      const headers = request?.headers?.() || {};
      const candidate = extractImaClientIdentity(
        headers['x-ima-cookie'] || headers['X-Ima-Cookie'] || '',
      );
      captured = requireImaClientIdentity(candidate);
    } catch {
      // Partial startup requests are expected; retain the last complete carrier only.
    }
  };
  context?.on?.('request', onRequest);
  return Object.freeze({
    snapshot: () => captured,
    close: () => context?.off?.('request', onRequest),
  });
}

function applyImaClientIdentityToAccountDirectory(directory, value) {
  const identity = requireImaClientIdentity(value);
  const accounts = directory?.getPoolAccounts?.();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TypeError('ima_account_directory_empty');
  }
  let updatedAccounts = 0;
  for (const account of accounts) {
    const cookie = account?.headers?.['x-ima-cookie'] || account?.headers?.cookie || '';
    directory.updateCredentialsFromClient(account.id, {
      ...account,
      headers: {
        ...account.headers,
        'x-ima-cookie': mergeImaClientIdentity(cookie, identity),
      },
    });
    updatedAccounts += 1;
  }
  return Object.freeze({ updated_accounts: updatedAccounts });
}

function parseCookieHeader(cookieHeader) {
  const cookie = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    const key = String(rawKey || '').trim();
    if (key) cookie[key] = rawValue.join('=').trim();
  }
  return cookie;
}

function stringifyCookie(cookie) {
  return Object.entries(cookie)
    .map(([key, value]) => `${key}=${String(value == null ? '' : value).replace(/[;\r\n]/gu, '')}`)
    .join('; ');
}

function boundedCookieValue(value, field) {
  const text = String(value || '').trim();
  const limit = FIELD_LIMITS[field] || 0;
  if (!text) return '';
  if (!limit || text.length > limit || /[;\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError('ima_client_identity_invalid');
  }
  return text;
}

module.exports = {
  IMA_CLIENT_IDENTITY_FIELDS,
  applyImaClientIdentityToAccountDirectory,
  extractImaClientIdentity,
  mergeImaClientIdentity,
  observeImaClientIdentity,
  requireImaClientIdentity,
  summarizeImaClientIdentity,
};
