<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="IMA QA Web Agent：把已授权 IMA 共享知识库接成可嵌入、可管理的多会话问答服务" />
</p>

<p align="center">
  <a href="#五分钟跑通"><strong>开始部署</strong></a>
  &nbsp;·&nbsp;
  <a href="#账号接入"><strong>接入账号</strong></a>
  &nbsp;·&nbsp;
  <a href="#会话与账号池"><strong>理解会话与并发</strong></a>
  &nbsp;·&nbsp;
  <a href="#账号池并发演练"><strong>演练账号池</strong></a>
  &nbsp;·&nbsp;
  <a href="./docs/DEPLOYMENT.md"><strong>部署文档</strong></a>
  &nbsp;·&nbsp;
  <a href="./docs/ACCEPTANCE_TESTING.md"><strong>部署后验收</strong></a>
  &nbsp;·&nbsp;
  <a href="./CHANGELOG.md"><strong>更新日志</strong></a>
</p>

> 一个面向网站交付的 IMA 共享知识库问答服务。它通过**已授权账号**调用 IMA 网页端能力，提供流式回答、可持续追问的会话、来源卡片和可维护的账号池。

这份发布包只包含 **Provider A: IMA Web Agent**。部署它不需要 IMA OpenAPI、MIMO Key、本地语料或本地索引；启动时若配置成其他 Provider，会明确拒绝运行，避免交付时误走另一条链路。

## 它看起来怎样

![问答页：3DGS 入门问题的合成演示回答，展示连续会话、流式回答的排版与来源入口](./assets/readme/screenshots/qa-page.png)

上图使用的是**合成演示数据**，用来公开展示界面和信息层级，避免泄露任何共享知识库原文或真实会话。实际服务会使用你自行接入、且合法加入目标共享知识库的 IMA 账号完成问答。

<p align="center">
  <img src="./assets/readme/screenshots/embed-page.png" width="49%" alt="嵌入页的合成界面演示" />
  <img src="./assets/readme/screenshots/account-management.png" width="49%" alt="账号管理页的合成状态演示" />
</p>

左图是可嵌入网站的完整问答界面；右图是仅给维护者使用的账号管理页。两张图同样使用合成账号、来源和状态数据，不含 cookie、token、共享库 ID 或真实历史。

## 先找到自己的入口

![Provider A 的三类使用者入口：问答页、嵌入页与账号管理页](./assets/readme/entry-points.svg)

- **普通用户**打开 `http://127.0.0.1:3117/`：提问、管理自己的会话并继续追问。
- **网站接入者**使用 `http://127.0.0.1:3117/embed.html`：在网站中嵌入完整问答界面。
- **服务维护者**打开 `http://127.0.0.1:3117/admin.html`：使用管理员 token 接入、检查和维护账号。

> [!IMPORTANT]
> 公开仓库只包含源码、配置模板、文档和合成演示资产。`.env`、`runtime/`、浏览器 profile、账号库密钥、cookie、refresh token、共享库原文和真实会话必须一直保持私有。

## 它解决什么

IMA QA Web Agent 适合这样的场景：你已经有一个 IMA 网页共享知识库，希望把其中的问答能力以自己的网站页面或 iframe 交付给用户，同时需要可靠地管理多个已授权账号。

- 用户在问答页提问，得到流式答案和精选来源。
- 用户可以新建、切换、删除会话，并在 7 天默认保留期内持续追问。
- 网站可以同源嵌入 `/embed.html`，保留完整会话体验。
- 维护者在 `/admin.html` 查看账号可用性、冷却状态和登录续期情况。
- 每个账号只稳定承接一条上游问答；多账号让更多用户并行，不让同一个 IMA 登录态被并发挤压。

## 工作方式

![从共享知识库到网站问答的 Provider A 工作流](./assets/readme/workflow.svg)

服务端会为每个客户的会话固定 IMA 账号和 IMA session。后续追问仍走同一个上游 session，因此能延续上下文；不同客户的会话、历史、来源和上游 session 不会互相混用。

## 五分钟跑通

### 你要先准备

1. 一个 IMA Web 共享知识库的**数字 ID**。从网页地址里的 `knowledgeBaseId=` 获取；它不是 IMA OpenAPI 的 Base64 ID。
2. 一个或多个已合法加入该共享知识库的 IMA 账号。
3. 一台运行服务的服务器，以及一台能打开 Chrome、Chromium 或 Ego Lite 的维护机。两者可以是同一台电脑。
4. Docker Compose，或 Node.js 18.18 及以上版本。

### 初始化并启动

```bash
git clone https://github.com/19Chris19/ima-qa-web-agent.git
cd ima-qa-web-agent
npm ci
npm run setup:provider-a
docker compose up -d --build
```

初始化向导只会询问共享知识库 ID 和可选的业务网页域名，并创建私有 `.env`、管理员 token 与 `runtime/` 数据目录。账号登录态不会随仓库下载。

生产环境不要直接公开 `:3117` 或服务器 IP。容器默认只监听服务器本机，由 Nginx 提供 HTTPS 域名和公网入口。完整反向代理配置见 [部署文档](./docs/DEPLOYMENT.md#nginx)。

### 先选对部署路径

首次部署时，服务运行位置和扫码维护机不一定相同。按你的环境选择下面一条路径：

| 环境 | 服务怎么跑 | 第一个账号怎么接入 |
| --- | --- | --- |
| 有桌面的维护机，追求最直接的体验 | 在同一台机器原生运行 Node | 打开 `/admin.html`，页面生成二维码并扫码 |
| Docker、纯 Linux 或远程服务器 | 服务在服务器运行，服务器不需要桌面浏览器 | 维护机建立 SSH 隧道，再用 CLI 在维护机弹出独立浏览器扫码 |

Docker 镜像只包含 Provider A 服务，不包含 Chrome、Chromium、Ego Lite 或桌面环境。不要因为容器能启动就以为它能自动弹出二维码窗口；远程服务器请按 [远程服务器 + 本机扫码](./docs/DEPLOYMENT.md#远程服务器--本机扫码) 操作。两条路径最终都把登录态加密写入服务端账号库，运行期问答不依赖扫码窗口。

桌面维护机原生运行的最短路径是：

```bash
npm ci
npm run setup:provider-a
npm start
```

然后打开 `http://127.0.0.1:3117/admin.html`，输入初始化向导生成的管理员 token，逐个点击“接入账号”。

## 账号接入

运行中的服务通过“受控浏览器接入”保存账号登录态。优先打开 `/admin.html`，输入管理员 token 后点击“接入账号”：填写名称后，服务默认打开独立、可见的 IMA 临时浏览器；在该窗口内只使用待接入账号扫码并完成手机确认，服务再自动验证共享知识库、加密保存凭证、关闭临时窗口并刷新账号池。**每次接入不使用维护机已登录微信的快捷登录。**

管理页负责显示脱敏阶段、聚焦受控窗口、取消任务和成功回执；它不会把页面截图中的二维码当作默认登录通道。只有已验证的 IMA 网页授权会被保存。二维码、临时浏览器 profile 和未成功的登录状态不会保留，运行期也不依赖浏览器窗口。需要排查嵌入二维码问题时，维护者可显式设置 `IMA_WEB_AGENT_ENROLLMENT_BROWSER_MODE=background`。

账号池按扫码后取得的 IMA 登录身份做服务端不可逆指纹去重，不以维护者填写的名称作为身份依据。同一 IMA 账号不能通过更换名称占用额外并发；旧账号库中发现的重复身份会自动停用并在管理页标记，保留原记录供维护者确认后删除。

页面二维码接入需要 **运行 Node 服务的维护机** 能访问 Chrome、Chromium 或 Ego Lite；可以用 `IMA_WEB_AGENT_BROWSER_PATH` 指定可执行文件。Docker 或纯 Linux 服务端没有桌面浏览器，因此不要在服务器上等待管理页弹窗；请在有图形界面的维护机使用下方 CLI + SSH 隧道方式，或把 Provider A 原生运行在维护机上。

CLI 是兼容兜底方式：

```bash
npm run admin:enroll -- \
  --name account-a \
  --server-url http://127.0.0.1:3117
```

命令会按顺序完成：

1. 校验管理员 token、账号名称和目标共享知识库。
2. 打开与其他账号隔离的临时浏览器窗口。
3. 由维护者只使用待接入账号扫描二维码，并确认账号已经加入目标共享库。
4. 服务端调用 IMA session 初始化接口验证访问权限。
5. 验证成功后加密保存登录态，关闭浏览器；失败时不写入账号池。

继续增加账号时，只换一个未使用的名称：

```bash
npm run admin:enroll -- \
  --name account-b \
  --server-url http://127.0.0.1:3117
```

同名账号默认拒绝覆盖。确定要重新扫码绑定时，显式添加 `--replace`。服务器没有图形界面时，通过 SSH 隧道在维护机扫码，见 [远程服务器 + 本机扫码](./docs/DEPLOYMENT.md#远程服务器--本机扫码)。

## 会话与账号池

### 会话如何保持追问

- 一个客户可以拥有多个会话；点击“新建会话”不会删除旧记录。
- 同一会话的追问持续使用它已绑定的 IMA 账号和 IMA session。
- 会话历史与最多 10 条精选来源会一同保留，默认 TTL 为 7 天，可用 `IMA_QA_CONVERSATION_TTL_MS` 覆盖。
- 浏览器直连使用 HttpOnly 客户端标识；客户后端代理时，应为每位已登录用户传不同的 `X-IMA-Client-Id`。
- 非归属客户、未知或过期会话一律返回 404，不暴露账号池、内部 session 或其他用户历史。

### 账号数和并发是什么关系

稳定基线是：**一个账号同一时刻只处理一条 IMA 问答**。在默认 `auto` 容量模式下，账号池容量会跟随已启用账号数自动变化：两个可用账号可稳定承接两条上游问答，新增一个账号后立即增加一条容量，不需要重启。

多个会话可以映射到同一账号，但同一时间会排队使用该账号。这样既能保持多轮上下文，也避免将并发请求压入同一个 IMA 登录态。不要把“账号数”理解为无限并发承诺；IMA 的限流、登录态和风控仍由上游决定。

| 状态 | 服务行为 |
| --- | --- |
| 账号可用 | 按最近最少使用原则调度新的会话 |
| 账号忙碌 | 同账号后续请求排队，不并发复用 active ask |
| IMA 限流或“提问太快” | 该账号进入冷却，其他可用账号继续处理 |
| 登录失效或共享库权限失效 | 该账号停止调度，已有会话不偷偷迁移，维护者重新接入该账号 |

### 账号池并发演练

`/admin.html` 的“并发演练”直接验证真实 IMA 端到端能力，不需要手工同时点击多个浏览器窗口。它从内置 3DGS 评测题库生成可编辑脚本，并为每位模拟客户建立独立会话：首问同批提交，成功后再以同一 IMA 账号和上游 session 发起一条追问。

- **基线并发**：模拟客户数等于当前可用且身份独立的账号数，确认每个账号实际提供一条稳定并发。
- **排队压力**：模拟客户数等于可用账号数的两倍，确认队列最终清空、追问不中断且失败按登录、限流、网络或超时分类。
- **自定义**：可配置 `1-30` 位模拟客户并改写首问和追问；问题应与当前共享知识库相关，否则质量结论没有意义。

内置题库当前有 50 道 3DGS 问题。一次生成时自动分配不重复；若将来题库小于模拟客户数，剩余客户的首问会留空并明确要求手写，不会循环复用题目。脚本中的模拟客户、首问和追问可以逐条展开或收起，也可以一次性全部展开或收起。

演练会产生真实 IMA 问答调用。为避免混入普通用户流量，它仅在普通队列为空时启动，期间普通 `/api/ask` 会明确返回 `503`，完成、取消或服务重启后自动恢复。演练不会刷新、导出或覆盖账号凭证，也不会写入普通客户的七天会话历史。

结果按“一个模拟用户一问一答”展示：精选来源、检索摘要、排队耗时、首段响应耗时、总耗时、账号显示名和隔离检查都可复核。每位模拟客户及其首问/追问都可独立展开或收起，报告提供全局展开、全局收起和关闭当前复核视图。质量评分由维护者按相关性、完整性、来源可信度和追问连贯性各 `0-2` 分填写，系统不伪造质量分。脱敏报告只保存在被 Git 忽略的 `runtime/` 中，默认保留 7 天，可下载 JSON 或手动删除。

## 网站嵌入与 API

同源网站直接嵌入完整体验：

```html
<iframe
  src="/embed.html"
  style="width: 100%; height: 640px; border: 0"
  title="共享知识库问答"
></iframe>
```

外站 iframe 与前端直调 API 时，在 `.env` 的 `ALLOWED_ORIGINS` 中配置精确的 `https://` 业务域名，并使用 Nginx 反代。SSE 需要关闭 buffering；反代、CORS、CSP 和 API token 的完整规则在 [部署文档](./docs/DEPLOYMENT.md#nginx)。

内部的 `/internal/` 路由只供受保护的私有深查集成使用，**不能**通过 Nginx 暴露到公网。

## 二次开发示例：消息机器人

仓库附带一个只在终端运行的适配器示例，展示如何把不同用户的消息映射到各自会话，再向 Provider A 请求答案：

```bash
node examples/bot-adapter/run.mjs
```

默认使用合成回答，不需要账号、网络或 API 凭证。准备好 Provider A 服务后，可在受信任的后端设置 `PROVIDER_A_URL` 和 `PROVIDER_A_SERVICE_TOKEN`，使用 `node examples/bot-adapter/run.mjs --real` 发起真实问答。该示例调用服务端的容量接口和受保护的深查接口；服务 token 不进入浏览器。

示例不接入微信或 Android，也不包含平台消息收发。它演示用户隔离、同一用户串行沿用会话、容量读取和保守的重复消息处理。每条平台消息使用稳定消息 ID 调用 Provider A 的持久幂等接口；机器人本身仍需持久保存消息处理状态，并对平台回复做去重。架构、事件与失败状态见 [机器人适配契约](./docs/BOT_ADAPTER.md)。

## 维护与验证

首次部署或测试候选分支时，请按[部署与真实验收指南](./docs/ACCEPTANCE_TESTING.md)使用独立目录、配置和端口完成扫码、知识库问答、来源、追问及重启恢复检查。代码测试通过不等于已经对真实 IMA 账号或上游完成验收。

### 日常查看

打开 `/admin.html`，输入私有 `.env` 中的 `IMA_QA_ADMIN_TOKEN`。管理页只显示脱敏状态，支持：

- 查看可用、忙碌、冷却和停用账号数。
- 查看令牌到期时间、最近错误和使用状态。
- 对单个账号做健康检查、刷新、启用、停用或删除。
- 在当前页面生成二维码、扫码接入新账号或重新绑定同名账号。

普通问答页、嵌入页和管理响应都不会返回 cookie、refresh token、账号加密密钥、上游 session ID 或内部账号凭证。

### 发布前验证

```bash
npm test
curl http://127.0.0.1:3117/healthz
```

并发和会话隔离应使用脚本验证，而不是手动同时点击：

```bash
npm run test:concurrency -- \
  --base-url http://127.0.0.1:3117 \
  --concurrency 2 \
  --follow-up
```

## 常见问题

### 为什么扫码后账号没有进入池？

接入命令会在保存前校验该账号是否能初始化**当前**共享知识库会话。账号未加入共享库、扫码未完成、网页拒绝会话或目标 ID 不一致时，都会拒绝写入账号池。

### 我在维护机退出 IMA，会立刻让服务失效吗？

不会立刻失效。运行期使用服务端加密账号库中的登录态和 refresh token，不依赖接入时的临时浏览器 profile。上游最终的 token 时长与风控由 IMA 决定；refresh 失败或权限失效时，只需重新接入受影响账号。

### 为什么两位用户的请求有时会排队？

同一账号固定一条 active ask。账号池在保持上游会话独立与稳定的前提下调度空闲账号；当所有账号都忙碌时，后续请求进入 FIFO 队列。增加已授权账号增加的是总并发容量。

### 为什么要保留 7 天会话？

7 天是试用阶段的默认平衡：用户能持续追问，服务端又不会无限保存历史。可以设置 `IMA_QA_CONVERSATION_TTL_MS` 调整。达到多实例部署或超过 5 个账号前，建议迁移到 Redis/PostgreSQL 和分布式锁。

### 可以把账号登录态、运行目录或真实问答截图提交到 GitHub 吗？

不可以。`.env`、`runtime/`、浏览器 profile、cookie、refresh token、账号库密钥、共享库原文、真实会话历史和运行日志都必须保持私有。发布前检查这些内容没有被 Git 跟踪。

## 深入阅读

- [部署与维护](./docs/DEPLOYMENT.md)
- [账号池策略与风控边界](./docs/WEB_AGENT_POOL_STRATEGY.md)
- [会话与账号池运行模型](./docs/SESSION_POOL_OPERATING_MODEL.md)
- [会话隔离架构](./docs/CONVERSATION_ARCHITECTURE.md)
- [人工体验场景](./docs/MANUAL_EXPERIENCE_SCENARIOS.md)
- [GitHub 发布和后续维护](./docs/GITHUB_RELEASE.md)

<details>
<summary><strong>高级私有集成：VoiceRAG 深查</strong></summary>

`apps/ima-voice-rag` 是主仓库中的独立实时语音入口。它仅在本地检索证据不足时，才可通过受保护的 `POST /internal/provider-a/deep-ask` 调用本服务。普通网页用户始终走公开 `/api/ask`。

该集成不属于本 Provider A 独立发布包。启用时须使用单独随机生成的 `IMA_QA_INTERNAL_SERVICE_TOKEN`，它必须与管理员 token、公开 API token 分离，且不得写入浏览器、日志或 Git。Nginx 必须拒绝 `/internal/` 路径。
</details>

## 许可

[MIT](./LICENSE)
