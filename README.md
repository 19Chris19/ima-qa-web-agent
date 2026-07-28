# IMA Shared Knowledge Base QA Web App

Lightweight read-only web QA for a single IMA shared knowledge base. The current local version proxies IMA Web's own knowledge-base Agent flow, so answers use IMA's shared-KB retrieval and stream back to the browser without calling Xiaomi MIMO in the normal path.

## Setup

```bash
cd apps/ima-qa-web
npm install
cp .env.example .env
```

Fill `.env` or `../../runtime/ima-web-agent.env` with local credentials. Do not commit either file.

Current local provider:

```env
IMA_QA_PROVIDER=ima-web-agent
IMA_WEB_KNOWLEDGE_BASE_ID=web-kb-id
IMA_WEB_AGENT_HEADERS_JSON={"x-ima-cookie":"...","x-ima-bkn":"..."}
IMA_WEB_AGENT_MODEL_ID=official_3
IMA_WEB_AGENT_MODEL_TYPE=3
IMA_WEB_AGENT_RUNTIME_ENV_PATH=/absolute/path/to/runtime/ima-web-agent.env
IMA_WEB_AGENT_TOKEN_EXPIRES_AT=1785257551943
IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT=1787842056525
IMA_WEB_AGENT_REFRESH_SKEW_MS=600000
IMA_WEB_AGENT_REFRESH_INTERVAL_MS=60000
```

`IMA_WEB_KNOWLEDGE_BASE_ID` is the numeric ID used by IMA Web for the same shared knowledge base. The header JSON is a secret from a logged-in IMA Web session; keep it out of git and rotate it when the web login expires.

Optional fallback provider:

```env
IMA_QA_PROVIDER=openapi-mimo
IMA_OPENAPI_CLIENTID=...
IMA_OPENAPI_APIKEY=...
IMA_SHARED_KNOWLEDGE_BASE_ID=...
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=...
MIMO_MODEL=mimo-v2.5
```

The OpenAPI + Xiaomi MIMO path is kept for official-API compatibility and tests, but it is not used by the current LaunchAgent service.

## Run

```bash
npm start
```

For the local IMA Web Agent mode, `npm start` also auto-loads
`../../runtime/ima-web-agent.env` when it exists. That file is gitignored and
should be mode `0600`; it is rewritten after successful token refreshes.

Optional macOS LaunchAgent service for local development:

```bash
launchctl print gui/$(id -u)/com.openlongxia.ima-qa-web
launchctl kickstart -k gui/$(id -u)/com.openlongxia.ima-qa-web
launchctl bootout gui/$(id -u)/com.openlongxia.ima-qa-web
```

The LaunchAgent plist should live under `~/Library/LaunchAgents/`. It should not contain
secrets; it only needs to run `node server.js` in this app directory.

Pages:

- `http://localhost:3000/`
- `http://localhost:3000/embed.html`

For Linux/server/Docker deployment, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

API:

```http
POST /api/ask
Accept: text/event-stream
Content-Type: application/json

{
  "question": "问题",
  "history": [{ "role": "user", "content": "上一轮问题" }]
}
```

The API rejects any request that attempts to specify a knowledge base. In Web Agent mode it always reads `IMA_WEB_KNOWLEDGE_BASE_ID`; in OpenAPI fallback mode it always reads `IMA_SHARED_KNOWLEDGE_BASE_ID`.

Optional production controls:

```env
ALLOWED_ORIGINS=https://your-domain.example.com
IMA_QA_API_TOKEN=replace_with_a_long_random_server_token
```

When `IMA_QA_API_TOKEN` is set, `POST /api/ask` requires `Authorization: Bearer ...`. Use this for server-to-server API access; do not put the token into public frontend JavaScript.

## Retrieval Notes

IMA OpenAPI is reliable for shared-KB metadata, search, notes, and downloadable files. Some shared raw Markdown/chat-log entries can appear in `get_knowledge_list` but fail through `get_media_info` with an IMA-side “view in ima” error. The OpenAPI fallback handles that by combining multi-query search, readable note/PDF extraction, and a shared-corpus overview from the configured KB only.

IMA Web has a separate knowledge-base Agent flow (`init_session` -> `assistant/qa`) that can retrieve many more raw chat-log references and streams answer chunks. In a local benchmark against the shared 3DGS KB, it started retrieval status in about 6.6s, answer text in about 7.4s, and completed in about 12.3s while returning 100+ references. This is the current local service path.

The Web Agent adapter works like a small local service:

- It refreshes proactively when the short web token is within `IMA_WEB_AGENT_REFRESH_SKEW_MS` of expiry.
- It also retries once after a login failure by calling IMA Web's refresh endpoint with the local `IMA-REFRESH-TOKEN`.
- After a successful refresh, it updates the in-memory `x-ima-cookie` / `x-ima-bkn` headers and safely rewrites `IMA_WEB_AGENT_RUNTIME_ENV_PATH` with mode `0600`.
- `/healthz` exposes sanitized expiry metadata such as remaining seconds and runtime persistence status, never raw cookies or tokens.
- If the refresh token itself expires, refresh the browser login and regenerate the local runtime env file.

## Maintenance Notes

Authentication:

- The short `IMA-TOKEN` is expected to last about 2 hours. The service checks every `IMA_WEB_AGENT_REFRESH_INTERVAL_MS` and refreshes when the remaining time is within `IMA_WEB_AGENT_REFRESH_SKEW_MS`.
- The refresh token is expected to last about 30 days. It cannot be refreshed forever; when `/healthz` shows `refreshTokenSecondsRemaining` near zero or refresh starts failing, open IMA Web in the logged-in browser and regenerate `runtime/ima-web-agent.env`.
- After a successful refresh, the service rewrites `runtime/ima-web-agent.env` with mode `0600`. Do not copy that file into commits, logs, issue reports, or screenshots.
- Use `/healthz` for maintenance checks. It should show `provider`, `model`, token expiry timestamps, remaining seconds, and `runtimePersistence`, but never raw `x-ima-cookie`, `IMA-TOKEN`, or `IMA-REFRESH-TOKEN`.

IMA knowledge base:

- The app does not maintain its own vector index or document cache in Web Agent mode. New or edited IMA shared-KB content is picked up by IMA Web's own retrieval once IMA has indexed it.
- If answers look stale after a knowledge-base update, first verify the same question in IMA Web with `@` selecting the shared KB. If IMA Web is updated but this app is not, restart the local service with `launchctl kickstart -k gui/$(id -u)/com.openlongxia.ima-qa-web`.
- If the shared KB is replaced or recreated, update `IMA_WEB_KNOWLEDGE_BASE_ID` in the runtime env. Do not accept a KB ID from frontend requests.

Xiaomi MIMO:

- The current LaunchAgent service does not call Xiaomi MIMO. It streams the answer produced by IMA Web Agent.
- Keep `MIMO_*` variables only for the optional `openapi-mimo` fallback path. They are not required for the current local service.

## Verify

```bash
npm test
```
