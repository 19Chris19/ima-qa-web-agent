# ima-qa-client

独立 CLI + STDIO MCP + 单入口 **ima 知识库助手** Skill。Node.js 22+。

源码安装：`npm ci --ignore-scripts`，然后 `node bin/ima-qa.mjs setup --agent codex --config /absolute/path/client.json`。

已有本机服务可先 `node bin/ima-qa.mjs connect-local --provider-env /absolute/private/provider.env --base-url http://127.0.0.1:3117 --config /absolute/private/client.json`。它只导入普通/服务凭据与知识库范围，不启动服务，不复制管理员凭据或 Cookie。

没有 Provider 时按随包提供的 [首次使用流程](skills/ima-qa/references/first-run.md) 部署固定版本并由人扫码；只安装 Skill 不会自动拥有账号。已有远程 Provider 则由维护者提供受保护配置，无需重复部署账号池。

六个 MCP 工具覆盖状态、问答、任务、会话、显式取消和私有导出。问答默认返回精简视图，终态用 get_task(view=full) 读取全文，或 export 后从本机文件读取完整证据。[IMA 操作经验](skills/ima-qa/references/ima-workflow.md) 固化联网意图、连续追问和精确引用等细节。

完整配置、凭据配对、命令和升级说明见仓库 [Agent 接入指南](https://github.com/19Chris19/ima-qa-web-agent/blob/main/docs/AGENT_INTEGRATION.md)。发布标签为 `agent-vX.Y.Z`，不要混用 Provider 的版本标签。

`node bin/ima-qa.mjs --help` 列出命令。安装后在 Codex 使用 `$ima-qa`；Skill 内部引用模块随主 Skill 更新。
