# ima-qa-client

独立 CLI + STDIO MCP + 单入口 **ima 知识库助手** Skill。Node.js 22+。

源码安装：`npm ci --ignore-scripts`，然后 `node bin/ima-qa.mjs setup --agent codex --config /absolute/path/client.json`。

完整配置、凭据配对、命令和升级说明见仓库 [Agent 接入指南](https://github.com/19Chris19/ima-qa-web-agent/blob/main/docs/AGENT_INTEGRATION.md)。发布标签为 `agent-vX.Y.Z`，不要混用 Provider 的版本标签。

`node bin/ima-qa.mjs --help` 列出命令。安装后在 Codex 使用 `$ima-qa`；Skill 内部引用模块随主 Skill 更新。
