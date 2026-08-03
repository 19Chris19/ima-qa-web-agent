# OpenAPI + MIMO RAG Strategy

这条路线的目标是做一套更适合开源交付和普通服务器部署的知识库问答能力。它使用 IMA OpenAPI 搜索固定共享知识库，按资料 ID 尝试补充可读内容，再用 MIMO 根据 EvidencePack 证据包组织答案。

## Feasibility

| 项目 | 预期 |
| --- | --- |
| 质量上限 | 中高，第一阶段目标约 60-80% |
| 稳定性 | 高，更像常规后端服务 |
| 主要收益 | 不依赖 IMA Web 登录态，适合客户自己部署 |
| 主要风险 | OpenAPI 可返回上下文有限，难完全复刻 IMA 网页内部调度 |

OpenAPI 路线值得继续打磨，但不要承诺 95% 复刻 IMA 原生体验。它的质量上限取决于 OpenAPI 能拿到多少可引用内容，而不是只靠提示词。

## Current Baseline

当前实现已经具备：

- 只搜索服务端固定的 `IMA_SHARED_KNOWLEDGE_BASE_ID`，前端不能覆盖。
- 多查询候选：原问题、英文/数字 token、中文压缩词、3DGS 领域词。
- 多页召回，以及命中后继续尝试更多改写 query，不再只命中第一批就停。
- OpenAPI 请求抗波动：对 HTTP 429、408、5xx、超时和频率超限类业务错误做有限次数指数退避；单个 query 失败时继续尝试其他改写 query。
- OpenAPI 额度保护：识别 `code=200005` / `请求超量，请明日再试` 后立即打开 quota 熔断；不再换 query、不再补 profile、不再 enrichment，后续请求直接返回 429 和 `failureReason=openapi_quota_exceeded`，避免继续消耗额度。
- EvidencePack 证据包：识别 `highlight_content`、`summary`、`description`、`content`、`chunk_content` 等多种返回字段；将同一资料的多段命中合并，保留内部 `mediaId` / `matchedQuery` 诊断，同时对外 sources 脱敏。
- 知识库 profile 补充：知识库名称、描述、推荐问题、根目录资料、raw/NotebookLM 文件夹概览。
- 对短片段来源按配置尝试 `get_media_info` / `get_doc_content` / URL / PDF 补全文本，片段足够长时跳过，避免无效调用。
- MIMO 生成时强约束：只依据共享知识库片段、中文优先、引用 `[1]`、不联网搜索、不暴露内部 ID。

## Runtime Knobs

Provider B 的默认值偏保守，适合先跑 30-50 题评测，再按实际失败原因微调：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `IMA_OPENAPI_REQUEST_TIMEOUT_MS` | `15000` | 单次 OpenAPI 请求超时。网络慢或 PDF/URL 补内容多时可适当调高 |
| `IMA_OPENAPI_MAX_RETRIES` | `2` | 瞬时错误重试次数。覆盖 429、408、5xx、超时、频率超限提示 |
| `IMA_OPENAPI_RETRY_BASE_DELAY_MS` | `800` | 指数退避基础间隔。被限流时不要设为 0 |
| `IMA_OPENAPI_MAX_ENRICHED_SOURCES` | `6` | 每轮最多补全文的来源数。调高会增加首包延迟和上游调用 |
| `IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD` | `700` | 片段短于该字符数时才补全文。调低可减少请求，调高可争取更多上下文 |

调参顺序建议：先看 `eval` 诊断里的 `retrievedSourceCount`、`matchedQueries`、`queryVariantCount`、`enrichedSourceCount` 和 `failureReason`，再决定是扩 query、加补全文，还是只提高超时/重试。不要一上来把所有阈值拉满，那样容易把 B 通道变慢，还更容易碰到上游限流。

## Quota-Safe Evaluation

Provider B 的评测必须按“小批量、可断点、可恢复”的方式跑。昨天 50 题重跑在第 31 题后触发 IMA OpenAPI `请求超量，请明日再试`，所以后续不要再直接全量重刷。

推荐节奏：

1. 先用 `--from-results ... --only-failed` 补跑旧结果里的失败题。
2. 再按 `--category rendering_application` 单独跑渲染应用题。
3. 再按 `--category advanced_troubleshooting` 单独跑高阶排障题。
4. 每次都用 `--concurrency 1 --delay-ms 5000 --timeout-ms 180000` 作为 Provider B 安全默认值。
5. 一旦报告里 `Stopped early=yes` 且 `Stop reason=openapi_quota_exceeded`，停止当天评测，等额度恢复后用 `--resume` 继续。

质量日志重点看：

| 字段 | 用途 |
| --- | --- |
| `failureReason` | 区分网络失败、OpenAPI 额度、MIMO 失败、无证据、超时等原因 |
| `queryVariantCount` | 判断是否做了足够积极的 query 改写 |
| `retrievedSourceCount` | 判断检索是否召回了足够来源 |
| `enrichedSourceCount` | 判断是否触发了 note/URL/PDF 补全文 |

如果 `retrievedSourceCount=0` 且 `failureReason=no_evidence`，优先看召回策略；如果 sources 充足但答案弱，优先看 prompt、EvidencePack 排序和 MIMO 生成。

## Optimization Roadmap

第一阶段目标是“80 分可交付”，不追求完全复刻 IMA 网页内部策略。

- 建评测集：第一版 50 题已落在 `eval/questions.jsonl`，每题记录 IMA 网页答案、Web Agent 答案、OpenAPI/MIMO 答案和人工评分。
- 召回扩展：继续根据 50 题失败样本补 3DGS 领域同义词和缩写表，但避免无限扩查询。
- 证据压缩：继续优化 EvidencePack 的排序和长内容截断；同文档邻近片段已经会进入合并链路，下一步重点是排序和引用校验。
- 答案评估：重点看是否引用正确、是否积极回答、是否诚实标出知识库未直接定义的边界。
- 可观测性：EvidencePack diagnostics 已接入评测 JSONL，记录 query 变体数、来源数、enrich 数和失败原因；后续可再接入服务端结构化日志，但仍不记录密钥或用户隐私内容。

## Internal Shape

当前内部形态：

```text
question
  -> buildQueryCandidates
  -> search_knowledge 多 query / 多页召回 / retry backoff
  -> get_media_info / get_doc_content / URL/PDF readable fetch 按需补内容
  -> buildEvidencePack 去重、合并、编号、脱敏
  -> prompt + MIMO
```

`IMAClient.searchKnowledge(question)` 仍然返回公开 sources，保持 `/api/ask` 兼容；`IMAClient.retrieveEvidencePack(question)` 返回内部证据包，给后续引用校验、质量日志和 MCP 工具封装使用。

## Acceptance Criteria

- 常见知识库内问题能给出直接答案，并附 `[1]`、`[2]` 来源。
- 知识库只给目录或弱片段时，能积极说明相关方向，同时标明“片段未给出严格定义”。
- 无可靠来源时不胡编，不建议用户去外部部门或网页搜索。
- 同一问题对比 IMA 网页，核心事实一致率达到可交付水平。
- OpenAPI 路线可在没有浏览器登录态的服务器上独立部署。

## When To Prefer This Route

- 给外部客户开源部署。
- 客户不愿维护 IMA Web cookie 和 refresh token。
- 更看重稳定、可解释、可审计，而不是最像 IMA 网页原生体验。
- Web Agent 账号池冷却、登录失效或私有接口变化时，需要降级服务。

## Known Limits

- 如果 IMA OpenAPI 不返回原文或足够片段，MIMO 不能凭空复刻 IMA 网页答案。
- PDF、Office、图片等二进制资料只能在 OpenAPI 提供可访问 URL 且格式可解析时补全。
- 知识库内部的排序、问题改写、跨资料压缩策略不是公开接口，无法保证完全一致。
