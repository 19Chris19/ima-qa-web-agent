# 知识库引用证据与原文读取

内部 Agent 证据保留正文显示编号、上游引用键和具体材料身份。公开 `chat_v1` 继续只显示知识库静态角标，不提供材料标题、ID、原文或 IMA 跳转。原文读取是独立能力，映射存在不等于已经读取原文。

## 材料映射

`knowledgeEvidence` 使用 `schemaVersion: 1`：

- `scopeRef`：发起问答的服务端固定知识库 ID 的 SHA-256。
- `materials`：按 `sourceRef` 去重的材料字典，保留 `materialId`、`idNamespace`，以及实际提供的标题、材料类型和所属库。
- `citations`：按 `index:<上游键>` / `context:<上游键>` 保存 `type`、`sourceRefs`、`displayNumbers`。一个引用可对应多份材料，一份材料可被多个引用使用。
- `upstreamPositions`：有界保留上游位置数据，`positionFormat=upstream_opaque`。未经验证的结构不解释成页码、段落或可直接导航的位置。

`sourceRef` 是范围、ID 命名空间和材料 ID 的摘要，不是授权凭证。文件列表只能补充具有相同明确身份的材料信息，不能按列表位置、标题或到达顺序制造引用关联。`media_id` / `mediaId` 和经过验证的文件条目 `id` 保留为网页端 `ima_web_media` 命名空间；不自动声称它们就是 OpenAPI 可接受的 ID。库 ID 也不做数字 ID 与 OpenAPI ID 的猜测转换。

缺失材料 ID 时保留空关联；来源缺少分类依据时仍为 `unknown`。明确的网页/知识库类型冲突会保持 `conflicted=true`，后续更新不能解除。缺失 `conflicted` 字段不补成 `false`。问答成功不依赖材料能否读取。

## 私有保存与接口

只有显式授权的命名内部应用任务记录私有材料证据；默认问答、知天下调用和机器人不增加材料字典。任务 JSONL 中的 `knowledge_evidence` 事件仅追加变化的材料和关系，并与对应的公开来源帧共用一次提交边界。显示编号补齐时只写关系变化；不会重复复制整份材料清单。终态会话归档保存一份规范化证据，用于事件过期后的同任务恢复。原文正文不进入这些问答事件。

默认任务读取、SSE、会话详情及 `chat_v1` 都不输出新增的私有证据字段。过滤私有事件后 SSE ID 可能有间隔，仍保持单调；游标使用服务端真实事件 ID，不按事件数量计算。

配置 `IMA_QA_SOURCE_EVIDENCE_APPLICATIONS_JSON='["ima-agent"]'` 后，同一命名应用的内部服务凭据可读取：

```text
GET /internal/provider-a/tasks/<taskId>?presentation=agent_evidence_v1
GET /internal/provider-a/tasks/<taskId>/events?presentation=agent_evidence_v1
```

任务读取在顶层返回 `knowledgeEvidence`；SSE 额外返回私有增量事件。普通凭据、legacy 身份和未允许的命名应用均不能启用此视图。客户端提供 applicationId 或自定义请求头不能替代服务端 token 映射。新视图仍校验原任务的应用、调用方和 internal scope。

容量接口只向被允许的内部应用报告 `features.knowledge_material_map_v1`。该字段证明接口支持映射，不证明当前某条引用有 ID，更不证明原文已核验。默认授权列表为空。

任务事件过期后，只有同归属、同会话、同 taskId 的仍有效会话轮次可恢复关联。旧归档没有可靠材料身份时继续无法定位，不自动重问、补配或重写旧缓存、导出。

## 验收范围

合成测试覆盖真实 HTTP 路由、JSONL 重启读取、会话重载、事件过期回退、来源乱序/重复/迟到、一对多、显示编号不同于引用键、来源冲突、应用越权及公开投影。它们不证明 IMA 当前会为所有引用返回材料 ID，也不证明网页 ID 与 OpenAPI ID 的兼容性。真实读取和部署需要独立验收。

## 按需原文读取

读取接口只安装在内部 Provider 入口，不增加知天下 BFF、普通浏览器或公网网关转发：

```text
GET  /internal/provider-a/source-evidence?taskId=...&conversationId=...&citationKey=index:...
POST /internal/provider-a/source-evidence/read
     {taskId, conversationId, citationKey, sourceRef, cursor?}
```

GET 返回该引用的材料列表、显示编号、mappingStatus 和读取配置状态，不读取原文。POST 只接受既有任务中明确关联的 sourceRef，不接受 URL、下载请求头、任意材料 ID、操作名或文件内容。缓存分页也先校验应用、调用方、任务、会话、知识库范围、引用关系与当前读取身份。botContract 任务不使用此通路。

网页端身份与 OpenAPI 身份通过维护者的私有配置衔接。设置 `IMA_QA_SOURCE_READER_CONFIG_PATH` 指向同 UID 的 0600 普通文件，所在目录必须为 0700；链接、过大文件、重复应用/范围、未知字段或不明 ID 策略均被拒绝。模板在 [source-reader-config.example.json](../examples/source-reader-config.example.json)，其中全部值均为不可用占位。

每个 reader 的 applications 与范围必须和映射授权一致，普通/内部 token 仍由 APPLICATION_IDENTITY 配对。reader 的 clientId/apiKey 是 IMA OpenAPI 身份，不是 Agent 的 clientId 或 Provider token；它们只发送到两个固定 HTTPS IMA OpenAPI 端点，不进入客户端、日志或导出。配置需要维护者受控重载，不在读取时自动登录、刷新网页凭证或要求扫码。

两种 ID 策略：

- `explicit_bindings`：明确将原生材料 ID 对应到已确认的 OpenAPI ID。缺少绑定时返回 identity_unverified，不试探其他材料。
- `verified_passthrough`：仅在维护者验证了该范围的 ID 合同后使用，要求 verificationReference 指向私有验收记录。填写字段本身不是验收证据，合成测试不证明真实 ID 兼容。不得截断、编码猜测或按标题补配。

每次新的原文读取先调用 get_media_info；笔记按实际返回的 notebook_id 调用 get_doc_content，文件使用实际返回的授权地址。上游拒绝、材料身份不符或没有可读内容时返回明确错误，不调用模型、不影响原问答状态。首次读取后的分页来自同一不可变快照，不逐页再次访问 IMA；每页重新校验 Provider 授权，读取身份变化使旧游标失效。快照不是问答发生时的材料版本。

## 资源和格式限制

- 单实例一个按需 worker，无等待队列；包括超时、取消后的终止过程，也不启动第二个 worker。空闲 60 秒退出。
- 所有应用共享滚动 60 秒最多 6 次新原文读取；来源查看与缓存分页另有每调用方 60 次/分钟限制。失败尝试占用新读取预算，无自动重试或预取。
- 单次完整获取/提取最长 10 秒。文件和笔记响应最多 5MiB，流式校验实际及解压后字节数，不只相信 Content-Length；最多两次文件重定向，API 不跟随重定向。
- 最多提取 128000 个 UTF-16 字符，每页至多 8000 字符。完整提取和页齐分别标注；不能用部分原文声称整篇已核验。
- 分页快照只保存在内存，5 分钟到期，最多 16 份/8MiB；归属校验在缓存读取之前。重启后旧游标失效，不自动重新抓取。长期私有归档由客户端另外保存。
- 仅接受笔记正文、UTF-8 文本/Markdown 和 HTML 文字。HTML 不执行脚本，也不加载嵌入资源。
- **PDF 在当前配置中禁止启用。** 现有解析依赖处理极小样例的额外 RSS 超过 64MiB 门槛；PDF 仅保留隔离测试探针，HTTP 在响应头阶段拒绝 PDF，不下载正文。Office、扫描件/OCR、音视频亦不自动处理。需优化并通过独立资源验收后再增加格式能力。

下载只允许公开 HTTP/HTTPS，校验全部 DNS 地址并固定连接目标；每次重定向重新校验，阻断本机、内网、Tailscale 地址及 HTTPS 降级。含查询参数（可能携带签名）或身份请求头的下载只允许 HTTPS，首版仅接受上游提供的 x-cos-security-token，跨来源重定向不转发。Cookie、Authorization、IMA 登录态和 Provider 服务凭据不转发到材料网址。错误只返回固定代码，不输出原始异常、问题、真实 URL 或上游错误正文。

独立 worker 处理 DNS/HTTP、JSON、HTML 解析；文件内容不写入问答日志，不占用账号或问答队列。问答已有排队或处于维护状态时拒绝新的原文抓取；已授权分页仍可读取。

资源脚本：`node scripts/bench-source-reader.cjs`。每种模式计时 30 轮固定合成 SSE，使用真实读取/提取代码及合成外部 HTTP，预算时钟独立模拟；不启动真实账号池、不联系 IMA。CPU、RSS、事件循环、健康和流式间隔结果及文本/PDF 独立进程探针保存在 [benchmark-20261016.json](evidence/benchmark-20261016.json)。此测量不证明公网下载性能、真实权限、长期运行或 3DGS 满载表现。
