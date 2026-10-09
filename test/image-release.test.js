const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..');
test('default published image matches the source package version', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const compose = fs.readFileSync(path.join(root, 'compose.images.yaml'), 'utf8');
  assert.ok(compose.includes(`ghcr.io/19chris19/ima-qa-web-agent:v${version}`));
});

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

test('Air image copies only the reviewed public synthetic qualification question bank', () => {
  const content = fs.readFileSync(path.join(root, 'eval/questions.jsonl'), 'utf8');
  // Changes to approved content need a fresh public/private-data disclosure review.
  assert.equal(createHash('sha256').update(content).digest('hex'),
    'e9353b32e5caf4845673d88e26b5fb2343bc67909d9563323b5d86382717c56b');
  const rows = content.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 50);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'suite', 'category', 'difficulty', 'question',
      'expectedSourceHints', 'expectedAnswerPoints', 'mustNotInvent'].sort());
    assert.match(row.id, /^3dgs_[a-z]+_[0-9]{3}$/u);
    assert.equal(row.suite, '3dgs_shared_kb_v1');
    assert.ok(['basic', 'intermediate', 'advanced'].includes(row.difficulty));
    assert.equal(typeof row.question, 'string');
    assert.doesNotMatch(row.question, /https?:\/\/|Bearer\s|wxid_|@chatroom|IMA-(?:TOKEN|UID)|\/(?:Users|home)\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/iu);
    for (const field of ['expectedSourceHints', 'expectedAnswerPoints', 'mustNotInvent']) assert.deepEqual(row[field], []);
  }
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY eval\/questions\.jsonl \.\/eval\/questions\.jsonl$/mu);
  assert.doesNotMatch(dockerfile, /^COPY\s+eval\/?\s/mu, 'Do not copy unrelated eval data or runners');
});
