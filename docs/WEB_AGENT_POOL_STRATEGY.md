# IMA Web Agent Account Pool Strategy

这条路线的目标是尽量复用 IMA 网页版 `@共享知识库` 的原生问答体验。它不是通用模型中转站，也不是绕过上游限制的高并发工具，而是把多个合法登录、已加入同一共享知识库的账号做温和调度。

## Feasibility

| 项目 | 预期 |
| --- | --- |
| 质量上限 | 高，最接近 IMA 原生体验，预期约 85-95% |
| 第一阶段规模 | 5 个账号 / 5 路上游并发 |
| 主要收益 | 降低单账号排队，减少同账号“提问太快啦” |
| 主要风险 | 登录态过期、账号风控、私有接口变化、同 IP/设备行为过密 |

单个账号仍建议 `maxConcurrent=1`。真实烟测里，同一账号 2 并发就可能触发 IMA 上游限流。账号池扩的是“可用账号数量”，不是单账号并发。

## Configuration

单账号继续支持：

```env
IMA_QA_PROVIDER=ima-web-agent
IMA_WEB_KNOWLEDGE_BASE_ID=your_ima_web_numeric_kb_id
IMA_WEB_AGENT_HEADERS_JSON={"x-ima-cookie":"...","x-ima-bkn":"..."}
IMA_QA_MAX_CONCURRENT_ASK=1
```

账号池使用：

```env
IMA_QA_PROVIDER=ima-web-agent
IMA_WEB_AGENT_ACCOUNTS_JSON='[
  {
    "name": "account-a",
    "knowledgeBaseId": "your_ima_web_numeric_kb_id",
    "headers": {"x-ima-cookie":"...","x-ima-bkn":"..."},
    "runtimeEnvPath": "/app/runtime/account-a.env"
  },
  {
    "name": "account-b",
    "knowledgeBaseId": "your_ima_web_numeric_kb_id",
    "headers": {"x-ima-cookie":"...","x-ima-bkn":"..."},
    "runtimeEnvPath": "/app/runtime/account-b.env"
  }
]'
IMA_QA_MAX_CONCURRENT_ASK=5
IMA_WEB_AGENT_ACCOUNT_COOLDOWN_MS=120000
IMA_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS=2
```

如果配置多个账号但不写 `IMA_QA_MAX_CONCURRENT_ASK`，服务默认使用 `min(账号数, 5)`。超过 5 个账号仍建议先压测，再显式提高。

## Runtime Behavior

- 每个请求从账号池租一个空闲账号，并且每次都新建 IMA session。
- 前端传来的 `history` 不参与 Web Agent 上游请求，避免上下文串号。
- 调度策略是 least-recently-used：优先使用最久没用过的空闲账号。
- 账号触发“提问太快啦”、HTTP 429 或连续错误后进入冷却。
- 账号出现登录失败、登录过期、未登录、鉴权失败后标记为 unavailable，直到维护者重新生成登录态并重启服务。
- 全局队列仍由 `IMA_QA_MAX_CONCURRENT_ASK` 和 `IMA_QA_QUEUE_LIMIT` 控制。

## Health And Operations

公网默认：

```env
IMA_QA_HEALTH_DETAILS=basic
```

`/healthz` 只显示：

```json
{
  "webAgentPool": {
    "totalAccounts": 5,
    "availableAccounts": 4,
    "busyAccounts": 1,
    "coolingDownAccounts": 0,
    "unavailableAccounts": 0
  }
}
```

维护环境可临时设置：

```env
IMA_QA_HEALTH_DETAILS=auth
```

这样会展示每个账号的脱敏状态和 token 剩余时间，但仍不会返回 cookie、API key 或 token 原文。

## Rollout

1. 先用 2 个账号真实烟测，确认两个账号都能通过 IMA 网页问同一个共享知识库。
2. 配置账号池，跑 2 并发 curl，确认答案流式返回、healthz 归零。
3. 扩到 5 个账号，跑 5 并发和 10 并发，观察排队、冷却、首字速度。
4. 只在没有上游限流和登录态异常时，再考虑提高 `IMA_QA_MAX_CONCURRENT_ASK`。

## What Not To Do

- 不要让一个 IMA 账号同时跑多个上游问答。
- 不要把 cookie、refresh token 或 `IMA_WEB_AGENT_ACCOUNTS_JSON` 写进 GitHub。
- 不要把账号池当成无限扩容方案。超过 10 个账号或 50 并发前，需要重新评估 IMA 风控、IP、登录态续期和合规边界。
- 不要把 New API、One API、Sub2API 当作 IMA Web 登录态池的直接替代品。它们适合通用模型网关和额度系统，IMA Web Agent 这层仍需本项目自有适配。
