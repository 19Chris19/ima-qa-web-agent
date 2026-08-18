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

新部署不需要手写 cookie、`IMA_WEB_AGENT_HEADERS_JSON` 或账号池 JSON。先运行初始化，再让每个已获授权的账号各扫码一次：

```bash
npm run setup:provider-a
docker compose up -d --build
npm run admin:enroll -- --name account-a --server-url http://127.0.0.1:3117
```

接入第二个账号时只改账号名。账号凭证会加密写入服务器私有的 `runtime/`，不会出现在浏览器、管理 API、公开文档或 Git 中。完整操作见 [DEPLOYMENT.md](DEPLOYMENT.md#逐账号接入)。

账号池默认使用自动容量模式：每个启用账号贡献一条上游并发。接入、停用或删除账号后，容量立即重算，无需编辑 `.env` 或重启；单个账号仍固定同一时刻只处理一条 IMA 问答。

如有明确的容量上限需求，才在私有 `.env` 中改为固定模式：

```env
IMA_QA_ACCOUNT_POOL_CAPACITY_MODE=fixed
IMA_QA_MAX_CONCURRENT_ASK=5
```

### 旧版私有配置迁移

以下变量仅用于已经存在的私有运行环境迁移，不是新部署入口，也不应把 cookie 或完整 JSON 粘贴到 Issue、日志或 Git。所有账号必须使用同一个 IMA Web 共享库数字 ID，例如文档中的虚构值 `123456789`：

```env
IMA_QA_PROVIDER=ima-web-agent
IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID=123456789
```

若旧版本曾导出 `runtime/web-agent-accounts/*.env`，使用 `npm run admin:seal-runtime` 预览迁移内容；确认后再加 `-- --apply`。新版本的加密账号库才是运行期唯一真源。

## Runtime Behavior

- 新会话的首轮请求从账号池租用一个空闲账号并创建 IMA session；同一会话的追问固定复用该账号和 IMA session。
- 客户端自由传入的 `history` 不直接参与 Web Agent 上游请求。服务端只使用已归属、已隔离的会话历史，避免伪造历史或不同用户串号。
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
