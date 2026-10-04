const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
test('version image publication is gated and immutable', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/images.yml'), 'utf8');
  assert.match(workflow, /linux\/amd64,linux\/arm64/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /image-smoke/);
  assert.match(workflow, /ubuntu-24\.04-arm/);
  assert.match(workflow, /needs: \[publish, smoke\]/);
  assert.doesNotMatch(workflow, /tags:.*latest/);
  for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) {
    assert.match(line, /@[a-f0-9]{40}/);
  }
});

test('Provider image declares provenance and copies no private runtime', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
  assert.match(dockerfile, /org\.opencontainers\.image\.source/);
  assert.doesNotMatch(dockerfile, /COPY\s+(?:\.\s|runtime|\.env)/);
});
