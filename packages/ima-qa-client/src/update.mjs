import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, fault, json } from './config.mjs';
import { defaultInstallDir, setup } from './install.mjs';

async function download(url, limit) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw fault('release_download_failed');
  const chunks = []; let size = 0;
  for await (const chunk of res.body) { size += chunk.length; if (size > limit) throw fault('release_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function update(options) {
  if (!/^agent-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(options.version || '')) throw fault('fixed_release_tag_required');
  const root = resolve(options.installDir || defaultInstallDir());
  const receipt = await json(join(root, 'installation.json'));
  const base = `https://github.com/19Chris19/ima-qa-web-agent/releases/download/${options.version}`;
  const archive = await download(`${base}/ima-qa-client.tgz`, 30 * 1024 * 1024);
  const checksum = (await download(`${base}/SHA256SUMS`, 4096)).toString('utf8').match(/^([a-f0-9]{64})\s+ima-qa-client\.tgz\s*$/m)?.[1];
  if (!checksum || digest(archive) !== checksum) throw fault('release_checksum_mismatch');
  const temp = await mkdtemp(join(tmpdir(), 'ima-qa-update-'));
  try {
    const tarball = join(temp, 'client.tgz'); await writeFile(tarball, archive);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['install', '--prefix', temp, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], { stdio: 'pipe' });
    const source = join(temp, 'node_modules/ima-qa-client');
    const manifest = await json(join(source, 'package.json'));
    if (`agent-v${manifest.version}` !== options.version) throw fault('release_version_mismatch');
    // Make this package self-contained before copying into the managed version directory.
    execFileSync(npm, ['ci', '--prefix', source, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { stdio: 'pipe' });
    return await setup({ ...options, installDir: root, config: receipt.configFile, profile: receipt.profile,
      skillsDir: dirname(receipt.skillTarget) }, { source });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
