# Deployment Guide

This app can be published as a normal Node/Express service or as a Docker container. It exposes a browser UI plus a streaming QA API for one fixed IMA knowledge base.

## Choose A Provider

Recommended for open-source users and normal servers:

```env
IMA_QA_PROVIDER=openapi-mimo
IMA_OPENAPI_CLIENTID=...
IMA_OPENAPI_APIKEY=...
IMA_SHARED_KNOWLEDGE_BASE_ID=...
MIMO_API_KEY=...
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_MODEL=mimo-v2.5
```

This path uses official IMA OpenAPI retrieval plus Xiaomi MIMO synthesis. It is easier to deploy because it only needs API credentials.

High-quality local/private path:

```env
IMA_QA_PROVIDER=ima-web-agent
IMA_WEB_KNOWLEDGE_BASE_ID=...
IMA_WEB_AGENT_HEADERS_JSON={"x-ima-cookie":"...","x-ima-bkn":"..."}
IMA_WEB_AGENT_TOKEN_EXPIRES_AT=...
IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT=...
IMA_WEB_AGENT_RUNTIME_ENV_PATH=/app/runtime/ima-web-agent.env
```

This path proxies IMA Web's private Agent flow and usually matches the IMA Web shared-KB QA experience more closely. It depends on a logged-in IMA Web session. Use it only where you can safely operate and rotate that login state.

## Docker Deploy

```bash
cd apps/ima-qa-web
cp .env.example .env
```

Edit `.env`, then run:

```bash
docker compose up -d --build
docker compose logs -f ima-qa-web
curl http://127.0.0.1:3117/healthz
```

The app listens on container `PORT` and maps to host `HOST_PORT`. By default `HOST_PORT=3117` and `PORT=3000`.

## Plain Node Deploy

```bash
cd apps/ima-qa-web
npm ci --omit=dev
cp .env.example .env
npm start
```

For production, run it behind a process manager such as systemd, PM2, Docker, or your platform's service runner. Do not use the included macOS LaunchAgent on Linux servers.

## Nginx Reverse Proxy

Server-Sent Events need buffering disabled:

```nginx
location / {
  proxy_pass http://127.0.0.1:3117;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 300s;
}
```

## API Usage

Streaming:

```bash
curl -N \
  -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"question":"3DGS 是什么？"}' \
  https://your-domain.example.com/api/ask
```

If `IMA_QA_API_TOKEN` is configured:

```bash
curl -N \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"question":"3DGS 是什么？"}' \
  https://your-domain.example.com/api/ask
```

The frontend must never send a knowledge-base ID. The server always uses the configured single KB.

## Security Checklist

- Keep `.env`, `runtime/`, cookies, refresh tokens, IMA API keys, and MIMO keys out of git.
- Set `ALLOWED_ORIGINS=https://your-domain.example.com` when other sites should not call the API from browsers.
- Set `IMA_QA_API_TOKEN` when exposing the API for server-to-server calls. Do not bake that token into public frontend JavaScript.
- Add reverse-proxy rate limiting before opening the service to the public internet.
- Check `/healthz` from monitoring, but do not publish it with raw server logs. It is designed to be sanitized, but operational metadata is still useful to attackers.

## Web Agent Login Maintenance

- Short IMA Web tokens are expected to last about 2 hours.
- Refresh tokens are expected to last about 30 days.
- The service refreshes the short token before expiry and rewrites `IMA_WEB_AGENT_RUNTIME_ENV_PATH` when it can.
- When the refresh token expires, log in to IMA Web again and regenerate the runtime env.
- If IMA changes its private Web endpoints, switch to `openapi-mimo` until the adapter is updated.

## Open Source Release Checklist

Before pushing to GitHub:

- Commit `.env.example`, not `.env`.
- Commit Dockerfile, compose file, docs, source, tests, and package lock.
- Do not commit `runtime/`, `node_modules/`, browser profiles, logs, screenshots containing tokens, or private KB content.
- Run `npm test`.
- Run a secret scan for known credential fragments.
- Decide whether to describe `ima-web-agent` as experimental/private and `openapi-mimo` as the official server deployment path.
