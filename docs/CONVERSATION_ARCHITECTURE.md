# 多轮会话与账号池架构决策

日期：2026-08-02

账号可以绑定多个客户会话、客户如何新建会话、历史恢复和账号级轮流调度的完整运行规则，见 [SESSION_POOL_OPERATING_MODEL.md](SESSION_POOL_OPERATING_MODEL.md)。

## 背景

IMA Web Agent 的问答 session 属于登录账号上下文。早期服务每次请求都新建 session，单问质量可以，但用户一追问就会丢掉上一轮语境。公网部署还必须保证不同用户的 history、sources 和上游 session 不互相串联。

外部网关项目的共同做法是：服务端持久化会话记录，用用户/会话键隔离，再把会话路由到具体渠道。Open WebUI 的 chat 数据按 `user_id` 和 `chat_id` 保存历史；New API/One API/LiteLLM 更侧重渠道和 token 路由，但不会替 IMA 这种私有网页登录态自动解决会话继承。

## 决策

采用服务端会话存储和账号/session 粘滞路由：

```text
client identity + conversationId
        -> local conversation record
        -> sticky IMA account
        -> reusable IMA session
```

每个会话同一时间只允许一条正在处理的请求。不同会话可以在不同账号上并行，每个账号仍保持最多一个 active ask。会话默认保留 7 天，存储文件使用临时文件写入再 rename，服务重启后恢复会话元数据。会话详情只通过公共投影返回历史和最多 10 条精选来源，内部账号和 session 字段不会出现在 API 响应中。

## 为什么不是全局 history

全局 history 会把不同网站用户或不同浏览器标签的内容混在一起；完全信任请求体里的 `history` 也允许调用方伪造上下文。当前服务端只把自己的会话记录交给 OpenAPI/MIMO 的 prompt，Web Agent 直接沿用该会话的 IMA session。

浏览器使用 HttpOnly `ima_qa_client_id` cookie 绑定归属；客户后端代理应使用每个登录用户独立的 `X-IMA-Client-Id`。`conversationId` 是服务端生成的随机 ID，未知 ID 或归属不匹配返回 404。

## 账号失效处理

同一个 IMA session 不能安全地从账号 A 迁移到账号 B。账号池因此只在新会话分配空闲账号；已有会话保持粘滞。如果绑定账号被禁用、登录态失效或正在冷却，会话返回安全错误，用户新建会话后由账号池重新分配。IMA session 自身失效时，当前账号只自动重建一次 session，并继续当前问题。

## 代价与后续

这种设计保留了 IMA 原生多轮体验，但单个会话无法跨账号迁移，账号池也不是把一个账号拆成无限并发。超过单实例规模后，应把会话和租约从 JSON 文件迁移到 Redis/PostgreSQL，并增加分布式锁；在此之前，单实例、5 个账号以内是当前验证过的合理边界。

## 参考项目

- [New API](https://github.com/QuantumNous/new-api)
- [One API](https://github.com/songquanpeng/one-api)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Open WebUI chat persistence](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/models/chats.py)
