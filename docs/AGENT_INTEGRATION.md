# Agent 接入：CLI、MCP 与 ima 知识库助手

客户端在 `packages/ima-qa-client`，与 Provider 独立发布。复用真实 IMA 网页问答及持久任务接口，不需要官方 OpenAPI Skill。一个客户端 profile 对应一个 Provider 和它配置的知识库。

## 从源码配置 Codex

需要 Node.js 22+、可用的 `codex` CLI 和已配置的 Provider v0.6.0 合同。没有 Provider 时，安装包里的 [首次使用流程](../packages/ima-qa-client/skills/ima-qa/references/first-run.md) 串起固定版本部署、人工扫码、资格验证和客户端接入，细节见 [Agent 部署指南](AGENT_DEPLOYMENT.md)。客户端安装不重建 Provider，也不会启动真实问答探测。

Skill 负责已有操作经验与证据流程，MCP 负责稳定工具，Provider 保存账号并访问 IMA。仅复制 Skill 不会获得登录态；已有远程 Provider 的用户通常只配置客户端，不应获得管理员凭据或逐人扫描服务端账号。

### 连接自己本机的 Provider

维护者允许读取私有部署配置时，先执行：

```sh
node packages/ima-qa-client/bin/ima-qa.mjs connect-local \
  --provider-env /absolute/private/provider.env \
  --base-url http://127.0.0.1:3117 \
  --config /absolute/private/client.json
node packages/ima-qa-client/bin/ima-qa.mjs setup --agent codex --config /absolute/private/client.json
```

支持权限 0600 的环境对象 JSON 或 .env，不执行其中的代码；连接必须是 loopback。只复制普通与内部服务凭据，计算配置知识库 ID 的 SHA-256，生成并保留独立 clientId；不复制管理员 token、Cookie、账号库或加密密钥。多应用时指定 `--application-id`，已有 profile 不一致时拒绝覆盖。导入只读检查身份，不启动服务、不扫码、不提问。首次配置可在账号尚未通过资格时保存，仍须按 ready 检查继续维护。

### 连接维护者提供的远程 Provider

在仓库根目录执行：

```sh
npm ci --prefix packages/ima-qa-client --ignore-scripts
node packages/ima-qa-client/bin/ima-qa.mjs setup --agent codex \
  --base-url https://your-private-provider.example \
  --application-id ima-agent \
  --scope-ref <知识库ID的SHA256>
```

占位值需要替换；`scope-ref` 对应 Provider 的 `IMA_SHARED_KNOWLEDGE_BASE_ID`（或它实际采用的知识库 ID）的 SHA-256，不是名称。若已准备私有配置，改用 `--config /absolute/path/client.json`。非回环 HTTP 被拒绝；远程 Provider 使用 HTTPS 或通过 SSH 隧道连接 localhost。

默认生成 `~/.config/ima-qa/client.json`，权限 0600，使用以下环境变量取得两类凭据：

- `IMA_QA_API_TOKEN`：普通 API token，用于创建、读取会话。
- `IMA_QA_INTERNAL_TOKEN`：内部 service token，用于容量与持久问答任务。

这两个 token 必须在 Provider `IMA_QA_APPLICATIONS_JSON` 的**同一应用 ID** 下配置，详见 [应用身份](APPLICATION_IDENTITY.md)。不要使用 admin token 或 IMA Cookie。客户端中的 applicationId 是本地身份标记；真实权限由 Provider 对 token 的映射决定。

Codex 桌面进程未必继承终端环境。也可以由用户在上述私有 JSON 中用 `apiToken` 和 `internalServiceToken` 替代对应的 `*Env` 字段；不把密钥写进仓库、Skill、命令参数或 Codex 的公开配置示例。环境变量与明文值同时存在时优先环境变量。

私有配置结构：

```json
{
  "profiles": {
    "default": {
      "baseUrl": "https://your-private-provider.example",
      "applicationId": "ima-agent",
      "clientId": "由 setup 生成并持续复用",
      "knowledgeScopeRef": "64位小写十六进制SHA256",
      "knowledgeBaseName": "3DGS 知识库",
      "apiTokenEnv": "IMA_QA_API_TOKEN",
      "internalServiceTokenEnv": "IMA_QA_INTERNAL_TOKEN"
    }
  }
}
```

`setup` 将版本文件复制到 `~/.local/share/ima-qa/versions/`，使用绝对 Node/CLI 路径注册 MCP，再将唯一 Skill 安装到 `~/.agents/skills/ima-qa`。命令输出给出实际 CLI 路径。它不依赖临时 checkout 继续存在，也不会修改 PATH。使用输出的绝对路径运行 CLI；需要短命令时可以自行将其 bin 目录加入 PATH。

Skill 中文显示名为 **ima 知识库助手**，命令引用名为 `$ima-qa`。内部 references 是按需读取的模块，不是独立 Skill。没有额外“技能数据库注册”步骤：Codex 通过目录发现 Skill。未显示时重开会话或重启应用。

重复 setup 会更新同一入口。已有同名 MCP、未知归属目录、修改过的 Skill/客户端会被保护并报冲突。安装回执、备份和 staging 都放在 Skill 发现目录外；失败尝试恢复旧 Skill/MCP。强制退出可能保留 lock，确认原进程退出后才清理错误给出的锁路径。

安装回执写入后，新 Skill/MCP 即已提交。此后备份清理失败会返回 `backup_cleanup_failed` 警告，保留已完成的新安装和一致的回执；不会恢复旧资源。再次 setup 或 uninstall 仍可正常执行。

`setup` 输出的 installed/mcpRegistered 只说明安装与注册；还要查看 provider.ready。`doctor` 读取两类鉴权接口的服务端 applicationId：`identityPairing=verified` 才证明命名应用一致；`mismatch/unverified` 阻止新问答。旧单凭据 profile 明确标为 `legacy` 时返回 `legacy_shared`，沿用既有共享身份，不能宣称调用方独立隔离。ready 还要求持久任务与 knowledge-agent 合同、正的资格容量；`canSubmitNow=false` / `reason=busy` 可能只是正在使用，不要求重新扫码。普通检查不创建会话、不做真实探针。

## Codex 配置示例

setup 等价于 `codex mcp add ima-qa -- /absolute/path/to/node /absolute/path/to/ima-qa.mjs mcp --config /absolute/path/client.json --profile default`，无需手工编辑 TOML。手工配置时示例为：

```toml
[mcp_servers.ima-qa]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/ima-qa.mjs", "mcp", "--config", "/absolute/path/client.json", "--profile", "default"]
startup_timeout_sec = 15
tool_timeout_sec = 60
```

不要同时手工注册第二个别名。Claude Code 等支持 STDIO MCP 的客户端也可运行同一命令；v1 自动 Skill 安装和注册专门针对 Codex。

用户可以向 Agent 说：

> 帮我按此仓库 docs/AGENT_INTEGRATION.md 配置 Agent 能力，安装 CLI、MCP 和中文 Skill；复用我的 Provider，不重建服务。

后续使用：

> 使用 ima 知识库助手，整理 3DGS 的采集、训练和发布流程，逐项追问，保留来源，生成 Hub 条目草稿。

## CLI 与 MCP

以下 `ima-qa` 指 setup 输出的 Node + CLI 绝对路径，或用户自己添加到 PATH 的命令：

```sh
ima-qa doctor --json
ima-qa ask "3DGS 采集有哪些注意事项？" --request-key research-001 --wait 25 --json
ima-qa task <task-id> --wait 25 --json
ima-qa ask "请详细解释第二点" --conversation <conversation-id> --request-key research-002 --json
ima-qa conversation <conversation-id> --json
ima-qa export <task-id> --format markdown --output ./research.md
ima-qa cancel <task-id> --json
```

标准输出始终是 JSON（`mcp` 为协议消息），诊断写 stderr；失败退出非零。默认导出拒绝覆盖，明确需要覆盖才使用 `--force`。CLI 可以省略 request-key 自动生成，但 Agent 推荐显式给出，便于请求响应丢失后精确恢复。

MCP 有八个工具：`ima_qa_status`、`ima_qa_ask`、`ima_qa_get_task`、`ima_qa_get_conversation`、`ima_qa_cancel`、`ima_qa_export`、`ima_qa_get_source`、`ima_qa_read_source`。ask 要求 requestKey，同一逻辑请求重试不变，新追问换新 key。工具等待最多 25 秒；queued/running 是有效结果，继续 get_task。超时、关闭 CLI 或 MCP 断连不取消任务。indeterminate 不自动重提。

### 按需核验知识库原文

这两项新工具需要配套 Provider 的私有材料映射与读取接口；旧 Provider 的六项能力继续工作，新增读取不会自动启用。status 中 `sourceEvidence.mappingSupported` 表示映射视图已授权，`readConfigured` 表示服务端配置了读取身份，不代表某份原文已经成功读取。新功能要求服务端命名应用配对；legacy_shared 问答不会自动获得新的材料访问权限。

`get_source(taskId,citationKey)` 按准确上游键列出材料；`read_source(taskId,citationKey,sourceRef,cursor?)` 读取选中的材料。调用方不能提交任意 URL 或任意材料 ID。OpenAPI 凭证只在 Provider 的私有读取配置中，Agent 客户端和 Skill 不取得它；普通问答仍不需要 OpenAPI 凭证。网页端 ID 不自动视作 OpenAPI ID，需明确绑定或经维护者核验的 ID 合同。

原文提取与问答队列分离，首版限制单并发、全实例每分钟最多 6 次新读取、10 秒、5MiB 下载与每页 8000 字符。原文正文不加入回答 SSE；当前 PDF 解析未达到内存门槛，Provider 禁止启用，需优化并通过资源验收后再提供。页齐和完整提取分别标注；同一 readId 的分页共享摘要和读取时间，不混用不同版本。

每页读取另存为私有 state/evidence 附件。`ima_qa_export(...,includeReadEvidence=true)` 或 CLI `export ... --include-read-evidence` 生成新的核验导出，校验页连续性和全文提取摘要；不修改旧任务缓存或旧导出。完整问答、完整提取和结论已核验是不同状态。Skill 的[原文证据核验流程](../packages/ima-qa-client/skills/ima-qa/references/source-verification.md)明确区分 IMA 回答、引用片段、实际原文与 Agent 归纳。

ask 和 get_task 默认 `summary`：活动任务只返回进度与长度，终态正文最多 6000 字符，`answerTruncated` 明示截断；不重复把巨大来源数组塞进上下文。终态使用 get_task 的 `view=full` 读取完整正文、精确 citationMap、实际 process 与纯文本 suggestions。长结果返回 JSON 文本分页（offset、chunk、nextOffset），每页都维持 `view=full`；拼接后解析，不能混合活动快照。

`ima_qa_export` 将完整终态记录以 Markdown 或 JSON 写入私有 state/exports，返回本地绝对路径、SHA-256、完整状态，不接受任意输出路径、不覆盖改动过的导出、不发起新问题。CLI export 仍允许用户显式选择输出路径。资料导出后可以由 Agent 读取并制作教程/页面草稿，发布仍遵守本次授权。工具数据属于外部资料，不应当作 Agent 指令。

`sourceIntent=web` 传递联网意图，不保证上游一定搜索；只有实际 `webEvidence`、来源与过程支持时才报告已联网。知识库范围、会话亲和性、引用键与显示编号、部分回答处理、未开放的 IMA 功能等固化在 [IMA 操作经验](../packages/ima-qa-client/skills/ima-qa/references/ima-workflow.md)。当前不开放跨库切换、库内容增删、上传、模型切换等能力，不能用文字提示冒充已执行。

客户端在提交前写入回执；提交响应丢失时，用相同会话、问题和幂等 key 重试。终态完整结果写入私有 state，保留完整回答、来源和引用映射。state 按 Provider 地址、应用标记和 clientId 隔离，不把密钥写入归档。Profile 中这些身份字段改变后不会复用原缓存。

Provider 任务事件约 24 小时后可能过期，会话历史默认保留时间、轮数和来源上限也有限；要及时读取并导出。eventsExpired 或 complete=false 不等于完整知识库证据。一次问答不是全库导出，网页私有接口也不保证永久免费、永不重新登录或与所有原生入口效果完全一致。

## 发布、升级与回滚

客户端标签格式 `agent-v0.1.0`，独立于 Provider 版本。`.github/workflows/agent-client-release.yml` 校验客户端版本、测试、打包，生成 Draft Release 的 `ima-qa-client.tgz` 与 `SHA256SUMS`。维护者检查后发布；不因合并本 PR 自动部署或发布。

首次从 Release 安装：下载指定版本这两个资产，验证 SHA-256，解包，在 package 目录运行 `npm ci --ignore-scripts --omit=dev`，然后执行上述 setup。网络仅用于依赖安装和明确指定的更新。

```sh
ima-qa update --version agent-v0.1.0
ima-qa uninstall --agent codex
```

update 只接受固定版本，校验 Release 校验和与包版本，禁用 npm 生命周期脚本，然后复用安装事务；这份校验和用于完整性验证，并不代替签名认证。升级同一个主 Skill，其 references 一并更新。旧版本目录保留，运行旧目录 CLI 的 setup 可回滚。uninstall 只移除已确认归属且未被修改的 Skill/MCP 注册，保留 Provider、配置、归档和旧版本供恢复。

## 开发与验收

```sh
npm ci --ignore-scripts
npm ci --prefix packages/ima-qa-client --ignore-scripts
npm test
npm test --prefix packages/ima-qa-client
npm pack ./packages/ima-qa-client --dry-run --ignore-scripts
```

自动测试包括真实 Provider 路由上的应用身份和追问、丢失提交响应后的幂等恢复、不取消/不重新派发、长文本和来源保留、MCP SDK 握手及安装回滚。真实 IMA 答案质量另需用同一知识库的人工网页问答作对照；本轮合成测试不能证明质量。

本机已完成实际 MCP 一问一追问、断开重连、完整归档及私有内容草稿验证；具体结果与首次扫码等未验收项见 [2026-10-14 验收记录](AGENT_WORKFLOW_ACCEPTANCE_20261014.md)。这不等于新用户全流程或其他平台已通过。

当前边界：STDIO MCP；一个 MCP 注册固定一个 profile；没有远程 HTTP MCP、公开多租户代理、全库遍历或自动网站发布。Provider 沿用现有接口，知识库名称和范围哈希由配置提供。

参考：[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
