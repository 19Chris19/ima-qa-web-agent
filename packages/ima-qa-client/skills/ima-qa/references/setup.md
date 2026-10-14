# 配置

已安装时，CLI 绝对路径、config 与 profile 可在 `codex mcp get ima-qa --json` 的 transport.args 找到；运行其中的 node 和入口路径，将 mcp 替换为 doctor / ask 等子命令即可。

尚未安装时，读取项目 `docs/AGENT_INTEGRATION.md`，使用固定 Release 或用户指定的本地 checkout。进入 `packages/ima-qa-client` 后执行 `npm ci --ignore-scripts`，再运行 `node bin/ima-qa.mjs setup --agent codex --config /绝对路径/client.json`。

不存在配置时，setup 还需要 `--base-url`、`--application-id`、`--scope-ref`。scope-ref 是 Provider 配置知识库 ID 的 SHA-256；不要拿知识库名称散列。新配置默认从 IMA_QA_API_TOKEN、IMA_QA_INTERNAL_TOKEN 读取凭据；桌面应用可能不继承 shell 环境，可由用户将两个 token 写入权限 0600 的私有配置。

两个 token 必须在 IMA_QA_APPLICATIONS_JSON 中属于同一个 application。不得使用管理员凭据、浏览器 Cookie 或其他应用 token 替代。缺少配置向用户询问缺失项，别在聊天或日志回显密钥。

已有 Provider 直接连接；无 Provider 使用项目 docs/AGENT_DEPLOYMENT.md 的部署与扫码流程，扫码由用户完成。不通过安装客户端重建现有 Provider。

setup 自动复制唯一 Skill 到 ~/.agents/skills/ima-qa，注册 STDIO MCP，并报告 Provider 检查结果。ready=false 不是完成连接。中文显示名是 ima 知识库助手，命令引用名为 $ima-qa。未刷新时重新打开 Codex 会话或重启应用。冲突保护失败时先检查现有文件归属，不能直接删除别人的安装。
