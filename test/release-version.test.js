const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReleaseVersion } = require('../scripts/release-version.cjs');

test('release tags accept exact stable or reviewed numbered rc versions', () => {
  for (const version of ['1.2.3', '1.2.3-rc.1', '1.2.3-rc.12']) {
    assert.doesNotThrow(() => validateReleaseVersion(`v${version}`, version));
  }
  for (const version of ['latest', '1.2.3-rc.0', '1.2.3-rc.01', '1.2.3-beta.1', '1.2.3+private', '01.2.3', '1.2.3;command']) {
    assert.throws(() => validateReleaseVersion(`v${version}`, version), /invalid_release_tag/);
  }
  assert.throws(() => validateReleaseVersion('v1.2.3-rc.1', '1.2.3'), /release_package_mismatch/);
});
