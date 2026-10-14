# Web citation cover previews

The ordinary `/api/source-preview` and service-authenticated
`/internal/provider-a/source-preview` GET routes accept exactly `conversationId`,
`taskId`, `citationKey`, and `sourceId`. The same query on `/image` reads the cached
image. A caller must own the conversation and task within its application and API
scope. URLs are resolved from explicit web citation relationships, never supplied
as fetch targets. `chat_v1` generates `sourceId` on read; raw records and bot
contracts are unchanged. Missing legacy relationships remain text-only.

Fetching is **off by default**. Enable only after host-specific synthetic
performance and UI acceptance, with Node 22:

```dotenv
IMA_QA_SOURCE_PREVIEW_ENABLED=true
IMA_QA_SOURCE_PREVIEW_CACHE_PATH=/absolute/private/runtime/source-preview-cache
```

The cache defaults beside the conversation store, outside source control, with a
0700 directory and 0600 files. Create an empty `disabled` file inside this directory
to stop new fetch jobs without restarting QA. Remove it to allow future explicit
requests. Cached data is disposable; no account, conversation or task data belongs
in this directory. A disabled or older backend leaves citation text and navigation
usable.

Only explicitly declared Open Graph / Twitter share images are used. They are
website covers, not screenshots or authenticated page contents. IMA's generic
file cover is not used. A single on-demand Node worker performs anonymous pinned
public HTTP, bounded head parsing and asynchronous cache writes, and exits after
60 seconds idle. It never launches Chromium, executes page code, decodes images or
calls IMA. Private, local, reserved and tailnet addresses, credentials, unsafe
redirects and unsupported image formats are rejected.

Global limits across all consumers: 1 fetch job, 0 waiting jobs; 6 new URLs and 12
HTTP attempts per rolling minute including redirects/images; 3 seconds total;
256 KiB decoded HTML, 512 KiB images. The worker uses V8 heap limits in addition to
bounded buffers; these are not a hard process RSS guarantee. QA queues, exhausted
capacity and maintenance shed new preview work. Cache hits make no outbound HTTP.
Successful cache TTL is 7 days; ordinary failures 1 hour, not busy/cancelled/quota
responses. LRU storage is at most 128 MiB / 2,000 entries, without periodic refresh.
Reads have separate per-owner limits (60/minute for metadata and images each),
at most 8 simultaneous cached image readers, and a bounded worker RPC count.

Responses are private `no-store`. Frontends use existing authentication to read
bytes, render short-lived blob URLs and revoke them on close. Gateways must
explicitly allow the two read-only paths and JPEG/PNG/WebP MIME types, rather than
expose a general URL proxy. Do not append previews to answer SSE or history.

Both frontends impose a separate **2-second total display deadline**, starting
with the first cover request after desktop hover intent (300ms) or explicit touch
activation. It includes metadata, image transfer and image decoding, and is shared
by all sources in that open panel. Expiry aborts optional work, retains source text
and links, and discards late results even if a loader ignores cancellation. Scroll,
repeated taps and late citation metadata do not restart the deadline or retry an
attempted source. An explicit close and reopening starts a new user-requested view.

Acceptance requires 30 paired synthetic SSE trials, p95 first-delta/inter-event
regression <=20ms, extra peak RSS <=64MiB, strict flood budgets, and timeout/worker
failure/SSRF/ownership tests. Real QA and production enablement require separate
approval. Account-maintenance browsers and Air robot routing are unrelated.
