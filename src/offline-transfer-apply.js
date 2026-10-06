const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const lockfile = require('proper-lockfile');
const { decryptAccount, validateAccountNamespace } = require('./account-transfer');
const { acquireMaintenanceStoreFence } = require('./account-store-fence');
const { readRetirement, markerPath, durableWrite, assertNotRetired, encode } = require('./source-retirement');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const ownershipBoundary = { sourceOwnershipTransferred: false, sourceMustRemainStopped: true };
const read = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw fail('transfer_input_invalid');
  return fs.readFileSync(file, 'utf8');
};

async function requireStopped(ports) {
  if (ports.length !== 2 || new Set(ports).size !== 2 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw fail('transfer_distinct_ports_required');
  }
  for (const port of ports) for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const done = error => { socket.destroy(); error ? reject(error) : resolve(); };
      socket.once('connect', () => done(fail('transfer_service_still_running')));
      socket.once('error', error => done(error.code === 'ECONNREFUSED' ? null : fail('transfer_stop_unverified')));
      socket.setTimeout(1000, () => done(fail('transfer_stop_unverified')));
    });
  }
}

async function applyPreparedTransfer({ bundle, sourceStore, sourceKey, targetStore, targetKey, sourcePort, targetPort, rollback = false }) {
  if (path.resolve(sourceStore) === path.resolve(targetStore) || fs.realpathSync(sourceStore) === fs.realpathSync(targetStore)) {
    throw fail('transfer_distinct_stores_required');
  }
  sourceStore = fs.realpathSync(sourceStore);
  targetStore = fs.realpathSync(targetStore);
  const files = [fs.realpathSync(sourceStore), fs.realpathSync(targetStore)].sort();
  const releases = [];
  try {
    for (const file of files) releases.push(await acquireMaintenanceStoreFence(file));
    assertNotRetired(targetStore);
    await requireStopped([sourcePort, targetPort]);
    // Match the ordinary store writer's lease settings; do not allow it to steal
    // a migration lock before this process's first heartbeat.
    for (const file of files) releases.push(await lockfile.lock(file, { retries: 0, stale: 10000, update: 2000 }));
    await requireStopped([sourcePort, targetPort]);
    const manifest = JSON.parse(read(path.join(bundle, 'manifest.json')));
    if (manifest.schemaVersion !== 1 || manifest.state !== 'prepared_not_applied') throw fail('transfer_manifest_invalid');
    const candidateRaw = read(path.join(bundle, 'candidate.accounts.json'));
    const originalRaw = read(path.join(bundle, 'target.accounts.json'));
    if (hash(candidateRaw) !== manifest.candidateHash || hash(originalRaw) !== manifest.targetHash) throw fail('transfer_bundle_changed');
    for (const [current, backup] of [[sourceKey, 'source.key'], [targetKey, 'target.key']]) {
      if (read(current).trim() !== read(path.join(bundle, backup)).trim()) throw fail('transfer_key_changed');
    }
    const candidate = JSON.parse(candidateRaw), original = JSON.parse(originalRaw);
    if (candidate.version !== 1 || original.version !== 1 || !Array.isArray(candidate.accounts) || !Array.isArray(original.accounts)) throw fail('transfer_manifest_invalid');
    validateAccountNamespace(original.accounts);
    validateAccountNamespace(candidate.accounts);
    const identities = new Set();
    const key = read(targetKey).trim();
    for (const row of candidate.accounts) {
      const { principal } = decryptAccount(row, key);
      if (identities.has(principal)) throw fail('transfer_candidate_duplicate_identity');
      identities.add(principal);
    }
    const originalIds = new Set(original.accounts.map(row => row.id));
    const added = candidate.accounts.filter(row => !originalIds.has(row.id));
    if (added.some(row => row.runtime?.disabled !== true)) throw fail('transfer_candidate_must_be_disabled');
    if (!rollback && added.some(row => row.runtime?.enrollmentQualificationRequired !== true)) {
      throw fail('transfer_candidate_qualification_required');
    }
    if (candidate.accounts.length !== original.accounts.length + added.length ||
        original.accounts.some(row => JSON.stringify(candidate.accounts.find(c => c.id === row.id)) !== JSON.stringify(row))) {
      throw fail('transfer_original_records_changed');
    }
    if (hash(read(sourceStore)) !== manifest.sourceHash) throw fail('transfer_source_changed');
    const sourceRaw = read(path.join(bundle, 'source.accounts.json'));
    if (hash(sourceRaw) !== manifest.sourceHash) throw fail('transfer_bundle_changed');
    const sourceIdentities = new Set(JSON.parse(sourceRaw).accounts.map(row => decryptAccount(row, read(sourceKey).trim()).principal));
    const transaction = hash(JSON.stringify([fs.realpathSync(sourceStore), fs.realpathSync(targetStore),
      manifest.sourceHash, manifest.targetHash, manifest.candidateHash, hash(read(sourceKey).trim()), hash(key)]));
    let marker = readRetirement(sourceStore);
    const save = value => { durableWrite(markerPath(sourceStore), encode(value)); marker = value; };
    if (marker?.state === 'retired' && marker.transaction !== transaction) throw fail('transfer_retirement_conflict');
    const currentRaw = read(targetStore), current = JSON.parse(currentRaw);
    if (current.version !== 1 || !Array.isArray(current.accounts)) throw fail('transfer_manifest_invalid');
    validateAccountNamespace(current.accounts);
    let output;
    if (rollback) {
      if (!marker) throw fail('transfer_retirement_missing');
      if (marker.transaction !== transaction) throw fail('transfer_retirement_conflict');
      const noSourceIdentity = rows => {
        if (rows.some(row => sourceIdentities.has(decryptAccount(row, key).principal))) throw fail('transfer_retirement_target_identity_present');
      };
      if (marker.state === 'released') {
        noSourceIdentity(current.accounts);
        return { state: 'already_rolled_back', sourceRetired: false, ...ownershipBoundary };
      }
      if (marker.phase === 'rolling_back' && hash(currentRaw) === marker.after) {
        noSourceIdentity(current.accounts);
        // Complete target durability before allowing source startup after recovery.
        durableWrite(targetStore, currentRaw);
      } else {
        if (marker.phase === 'rolling_back' && hash(currentRaw) !== marker.before) throw fail('transfer_rollback_target_changed');
        const neverInserted = marker.phase === 'sealed' && hash(currentRaw) === manifest.targetHash;
        for (const row of added) {
          const found = current.accounts.find(a => a.id === row.id);
          if (!neverInserted && (!found || JSON.stringify(found) !== JSON.stringify(row))) throw fail('transfer_rollback_account_changed');
        }
        const addedIds = new Set(added.map(row => row.id));
        output = { ...current, generation: Number(current.generation || 0) + 1,
          accounts: current.accounts.filter(row => !addedIds.has(row.id)) };
        noSourceIdentity(output.accounts);
        const raw = neverInserted ? currentRaw : encode(output);
        if (marker.phase === 'rolling_back' && hash(raw) !== marker.after) throw fail('transfer_rollback_target_changed');
        save({ ...marker, phase: 'rolling_back', before: hash(currentRaw), after: hash(raw) });
        durableWrite(targetStore, raw);
      }
      save({ ...marker, state: 'released', phase: 'rolled_back', completed: [...new Set([...marker.completed, transaction])] });
    } else {
      if (marker?.completed.includes(transaction)) throw fail('transfer_retirement_replay');
      if (marker?.phase === 'rolling_back') throw fail('transfer_rollback_pending');
      output = { ...original, updatedAt: candidate.updatedAt, accounts: candidate.accounts,
        generation: Number(original.generation || 0) + 1 };
      if (hash(currentRaw) === hash(encode(output))) {
        if (marker?.state !== 'retired') throw fail('transfer_retirement_missing');
        save({ ...marker, phase: 'applied' });
        return { state: 'already_applied', sourceRetired: true, ...ownershipBoundary };
      }
      if (hash(currentRaw) !== manifest.targetHash) throw fail('transfer_target_changed');
      if (marker?.phase === 'applied') throw fail('transfer_target_changed');
      if ((marker?.completed.length || 0) >= 1000) throw fail('transfer_retirement_history_full');
      save({ version: 1, state: 'retired', phase: 'sealed', transaction, completed: marker?.completed || [] });
      durableWrite(targetStore, encode(output));
      save({ ...marker, phase: 'applied' });
    }
    return { state: rollback ? 'rolled_back_unused_import' : 'applied_disabled', importedEnabledAccounts: 0,
      sourceRetired: !rollback, addedIdentities: rollback ? 0 : added.length, credentialsVerifiedOnline: false, ...ownershipBoundary };
  } catch (error) {
    if (error.code === 'ELOCKED') throw fail('transfer_store_locked');
    throw error;
  } finally {
    // Attempt every release even if one lease has already been lost.
    const results = await Promise.allSettled(releases.reverse().map(release => release()));
    if (results.some(result => result.status === 'rejected')) throw fail('transfer_lock_release_failed');
  }
}

module.exports = { applyPreparedTransfer, requireStopped };
