# Durable release candidate checkpoint

Date: 2026-10-10, Asia/Shanghai. Preparation, not publication.
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

## Remaining gates / actual runtime

Draft PRs: public Provider #14 and private website #8. Neither is merged or
published. Website container CI stops at missing fixed Provider RC image:
publish/accept Provider first, then rerun; never substitute a legacy SSE fixture.
Vercel preview deployed but its protected browser view is unaccepted. Ego
verification is paused under user control; do not bypass it with a new space.

Air remains Provider 97dbb5c, preview website 418cbdb0 and stable/public website
consolidation-32d469ce. This preparation preserves old admin/five-account data
and does not restart live services, dormant Docker Provider or robot. Prior
dated real first/follow-up evidence does not verify all latest corrections or
public recovery. No new real question was sent.

Promotion requires RC choice, paired image/manifest and CI acceptance, reviewed
local skill drift, protected preview acceptance and fresh idle/backup proofs.
Do not label RC stable Latest or automatically upgrade another installation.
Rollback drains admission and preserves ledgers/accounts/new histories; never
restore stale data or re-POST dispatched uncertain work.
