# 自定义网页后端接入合同（v0.4.0）

简单嵌入优先用 `/embed.html`；如果需要自定义页面、身份和会话管理，在**自己的后端**调用 Provider A，浏览器只连自己的后端。可运行的无凭据版本见 [`examples/web-bff`](../examples/web-bff/README.md)。本合同从 v0.4.0 起提供；v0.3.1 不包含带幂等键的原生流式接入。

## 凭证与路由

| 用途 | Provider A 路由 | 凭证 |
| --- | --- | --- |
| 存取普通会话历史 | `/api/conversations`、`/api/conversations/:id` | 普通 API token |
| 简单网页问答 | `/api/ask` | 普通 API token |
| 查看原生 Agent 容量 | `/internal/provider-a/capacity` | 内部服务 token |
| 自定义后端的原生流式问答 | `/internal/provider-a/deep-ask` | 内部服务 token |
| 账号管理 | `/api/admin/*` | 管理员 token，不能用于业务请求 |

`/internal/` 必须只在可信本机或内网由服务端访问，公网反向代理应拒绝该路径。普通 `/api/ask` 不接受 `retrieval_policy`、`knowledge_scope_ref`、`source_intent`；这些字段只在受保护的深查接口校验。

## 原生问答请求

先在管理页选择 `knowledge_agent`，并确认 `GET /internal/provider-a/capacity` 的 `schemaVersion === 1`、`features.knowledge_agent_keyed_sse_v1 === true` 且 `policies.knowledge_agent.max_concurrent > 0`。前两项证明带幂等键的原生流式合同可用；容量反映当前模式下有资格的独立账号数，和健康检查、账号总数不是一回事。`features.source_intent_web_requested_v1` 单独表示本轮联网意图合同是否可用。合同缺失或容量为零时应提示管理员处理，不要自动调用 IMA 做探测。已有经典模式会话不能静默转换；切换模式后新建会话。

服务端向深查接口发送 JSON：

```json
{
  "question": "与当前知识库相关的问题",
  "conversationId": "可选，使用服务端返回的会话 ID",
  "retrieval_policy": "knowledge_agent",
  "knowledge_scope_ref": "当前共享知识库 ID 的 SHA-256 小写十六进制值",
  "source_intent": "web_requested"
}
```

`source_intent` 可省略。`web_requested` 表示请求本轮尝试联网，**不是**“已取得网页来源”；未验证到网页来源时 `web_source_count` 为零。请求头包含 `Authorization: Bearer <内部服务 token>`、`X-IMA-Client-Id: <稳定且隔离的业务用户 ID>`、`Idempotency-Key: <每次提交稳定且唯一的键>`、`Accept: text/event-stream`。网页后端必须绑定自己的已认证用户，不能让浏览器自行指定其他用户的 Provider 身份。重复键的 SSE 返回 `409`，不会重派或重播；断流后应检查原会话记录，不自动换键重试。

## 流式与历史

SSE 事件为 `conversation`（获得 `conversationId`）、`sources`、任意个 `delta`、以及唯一的 `done` 或 `error`。正文按 `delta.text` 原序拼接；没有 `done` 或收到 `error` 时不可显示为完整回答。`done` 和随后读取的助手历史消息包含：

- `source_intent`：`web_requested` 或空字符串。
- `answer_basis`：`knowledge`、`web`、`mixed` 或 `agent_general`；这是已识别来源类别，不是质量分数。
- `source_count`、`knowledge_source_count`、`web_source_count`：脱敏非负计数。

上游未给出可分类来源时计数可能为零；不可仅凭联网意图、搜索摘要或 HTTP 200 宣称已经联网成功。真实问答验收需一条与知识库相关的首问和一条同会话追问，检查正文、来源、完成态、隔离与刷新恢复。合成测试不等于真实 IMA 验收。

## 生产化边界

示例只有本机签名 Cookie 和进程内合成回执。正式接入还需要自己的用户认证、持久请求回执、速率限制、超时与取消、日志脱敏和配额。服务端持久幂等会拒绝不确定请求的二次派发，但调用方仍需管理它自己的消息投递和 UI 重复提交。
