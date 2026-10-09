const fs = require('node:fs');
const path = require('node:path');

function validateReleaseVersion(tag, version) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/.test(tag || '')) {
    throw new Error('invalid_release_tag');
  }
  if (tag !== `v${version}`) throw new Error('release_package_mismatch');
}

module.exports = { validateReleaseVersion };
if (require.main === module) {
  const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  validateReleaseVersion(process.argv[2], version);
}
