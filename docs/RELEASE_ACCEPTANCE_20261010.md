# Durable prerelease publication and rollout

Date: 2026-10-10, Asia/Shanghai. Supersedes the earlier preparation checkpoint.
Pair: Provider v0.5.0-rc.1 / website v0.3.0-rc.1.
Tested Provider code: 7368be779040d049824f8ff37aeb7bffcb8172d8.
Tested website code: 25721c52b5343fa5aa7273055b7085a84d5e498c.
Later evidence-only commits do not change these tested implementations.

## Evidence

- Final complete local tests passed in both repositories; website build passed.
  Provider test-file concurrency two bounds test load, not service capacity.
- Provider tracked-source scan: 329 files, zero private paths/key patterns.
  Website tracked release scan passed (241 files).
- GitHub Provider Test and pack and website tests/build passed.
- Final Node/BFF/gateway/real Vercel-handler synthetic run: 371589ms, one
  subscription rotation, one dispatch, one terminal, exact whitespace/history.
  Only the tunnel hop was local; no actual Vercel/ngrok or IMA request.
- ARM64 and emulated AMD64 paired Nginx/BFF/Provider replay/cancellation/history
  and restart passed.
  Restart is indeterminate, never fabricated success or automatic re-dispatch.
- Both applications build and pass no-network startup/management smoke on ARM64
  and AMD64. Air-enabled Provider image startup passed on both. AMD64 is emulated
  on Air, not a performance or real Linux host availability claim.

Local image identities, not published registry digests:

| Application | Platform | Identity |
| --- | --- | --- |
| Provider | ARM64 | sha256:76ca8b29281368cbe4349f3e034fc90e5c4718d136055a41131a813302cfecd2 |
| Provider | AMD64 | sha256:0a83ef637f96963b70d0bc0df78cc42185e56874396652753342fdff6be7c214 |
| Website | ARM64 | sha256:0e6be2efc7d76a3c03f1c171afa87559fe0d9e7c427c1c18f1bd65b1efbf980c |
| Website | AMD64 | sha256:378ae2ca0541b0e14dce549e04c86015c41f61cfb814ec57695214d5c0a67eb5 |

## Published artifacts

User approved RC publication, local cutovers, skill update and browser control.
PR #14 merged as cd79ee6f9a058805f664ee8591d1bc0b0c0947f7. Tag/Release
v0.5.0-rc.1 points to that merge, is a prerelease and does not replace v0.4.2
Latest. CI tests, build, native ARM64/AMD64 startup and manifest jobs passed.
Public anonymous manifest pull verified both architectures and digest:
`sha256:5280e6155eec6559d9a4c5456ffebb6a3e8fad093e928b831cbf265c697f329c`.
The attached release-manifest.json pins this revision and image, not the local
candidate image identities above. Private website v0.3.0-rc.1 fixes this pair.

## Authorized Air rollout

After closing website admission and proving ordinary/durable/website queues
idle, private configuration and final runtime backups were taken. Air Provider
now uses an immutable export of the published merge, with its three previous
admin assets retained as an explicitly recorded local overlay. Five account
identities, encryption key and runtime configuration hashes remained unchanged;
capacity five, durable capability and recent-context robot extensions verified.
The robot and dormant Docker Provider were neither started nor restarted.
Websites and public proxy were updated independently; no account data was copied
into an image or repository. Existing conversations/task logs were preserved.

The initial startup readiness probe timed out; the same single process later
became ready without another Provider restart. Subsequent health/capacity checks
also showed intermittent latency. Air load averages exceeded 200 during rollout;
one website container readiness request returned 503. Three later sequential
health/capacity checks all succeeded (386-3886ms). This is correlated host load
evidence, not a conclusive explanation of every timeout or proof of stability.
Keep RC status and monitor; do not claim stable/24-hour acceptance.

## Browser and remaining evidence

Protected Vercel -> actual ngrok -> isolated candidate BFF/synthetic upstream
passed duplicate submission, first-delta viewer disconnect/cursor replay,
one terminal/history turn, table refresh and management/unknown-path blocking.
Desktop/390x844 browser checked. Synthetic traffic never used the stable origin
or real account pool; the temporary fixed-origin test router was removed.
Final public website reports the new task capability and five-account capacity.

Prior dated real first/follow-up evidence is not a new real IMA validation of
the published images. No additional real question was sent. Physical phone,
public long-running IMA recovery, Windows/SSH and Linux uptime remain unverified.
The Air Provider still listens on all interfaces: review LAN/firewall exposure
separately, without breaking the explicitly configured Docker host connection.

Rollback first closes admission and drains tasks, then selects compatible
durable-ledger code; keep new ledgers/history/accounts. Never overwrite live data
with older backups, re-POST uncertain dispatched work or silently upgrade a
colleague's installation. Legacy-only releases are not automatic fallbacks.
