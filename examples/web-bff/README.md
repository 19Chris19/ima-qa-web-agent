# 最小网页后端接入示例

这个示例用一个只监听本机的网页后端转接 Provider A。浏览器不持有普通 API token、内部服务 token 或账号凭据。它是教学示例，不是带账号体系、限流和生产监控的完整网站，也不包含知天下网站或微信群机器人的私有代码。

## 无凭据运行

从仓库根目录执行 `node examples/web-bff/server.mjs`，打开 `http://127.0.0.1:4320/`。默认合成模式可以提问、追问、刷新恢复与停止，不会调用 IMA。

## 真实 Provider A

先在 Provider A 管理页完成扫码、知识库问答验证，并切换到 `knowledge_agent` 模式。确认 `/internal/provider-a/capacity` 的 `policies.knowledge_agent.max_concurrent` 大于零。然后在此目录创建被 Git 忽略的 `.env.local`，填写：

```dotenv
WEB_BFF_MODE=real
WEB_BFF_PORT=4320
PROVIDER_A_URL=http://127.0.0.1:3117
PROVIDER_A_API_TOKEN=
PROVIDER_A_SERVICE_TOKEN=
PROVIDER_A_KNOWLEDGE_SCOPE_REF=
```

`PROVIDER_A_KNOWLEDGE_SCOPE_REF` 是当前部署共享知识库 ID 的 SHA-256 小写十六进制值，不是知识库 ID 本身。普通 token 对应 `IMA_QA_API_TOKEN`，服务 token 对应 `IMA_QA_INTERNAL_SERVICE_TOKEN`；管理员 token 不能替代任何一个。真实模式只从示例后端向 Provider A 发请求，不从浏览器直连 `/internal/`。

启动同一个命令即可。用一个与你的知识库相关、非私密的问题及一条追问验收。示例只把“请求联网”当作意图；只有 `web_source_count > 0` 才能说取得了可验证网页来源。断流或手动停止后不会自动重发。不同浏览器通过签名的本机 Cookie 隔离会话；示例重启后 Cookie 签名失效，生产应用应改用自己的登录身份和持久会话。

## 接口边界

服务端以 `retrieval_policy: knowledge_agent`、`knowledge_scope_ref` 和可选 `source_intent: web_requested` 调用受服务凭证保护的 `POST /internal/provider-a/deep-ask`。请求带稳定的 `X-IMA-Client-Id`、`Idempotency-Key` 与 `Accept: text/event-stream`。普通历史读取调用 `GET /api/conversations/:id`，只用普通 API 凭证。Provider A 回传 `conversation`、`sources`、`delta`，以及唯一的 `done` 或 `error`；没有 `done` 不算成功。重复键的流式请求返回冲突，不会再次派发到 IMA，也不会重放旧流。

示例默认只监听 `127.0.0.1`。若要放到公网，先加入正式身份认证、持久去重、速率限制、HTTPS、错误监控和明确的使用配额；不要直接暴露 Provider A 的 `/internal/` 路由。
