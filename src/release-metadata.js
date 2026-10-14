'use strict';
const { version } = require('../package.json');

function releaseMetadata(env = {}) {
  const revision = env.IMA_QA_RELEASE_REVISION || env.SOURCE_REVISION || '';
  return { version: `v${version}`, revision: /^[a-f0-9]{40}$/u.test(revision) ? revision : null,
    channel: version.includes('-') ? 'prerelease' : 'stable', taskRecordFormat: 'jsonl_v2' };
}
module.exports = { releaseMetadata };
