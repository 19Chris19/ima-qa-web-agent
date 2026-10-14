# FEAT-20261014-AGENT-INTEGRATION

User-Goal: 为真实 IMA 网页问答增加 CLI、STDIO MCP、一个中文显示名的 Codex Skill，以及可重复执行的安装升级流程；通过 PR 审查。

Base: ab67537461de7b4d92a08522d8be372f81a21049

实现独立 packages/ima-qa-client，复用 Provider 的持久任务与会话 API。保持 Provider 上游协议、账户与部署方式不变。Skill 使用一个入口和按需读取的 references。

验收：同会话追问、幂等重试、超时不取消、长答案和来源完整导出、MCP 协议连接、安装重复执行与冲突保护、中文单入口、配置无明文密钥、发布包校验。

分组：共享客户端和 CLI；MCP 与协议测试；Skill 安装升级与文档；完整验证及打包。

真实 IMA 验证需要已配置 Provider 与用户授权的提问；合成测试不作为回答质量证明。

## 实现与验证

- 共享客户端、JSON CLI、五个 STDIO MCP 工具；使用 MCP SDK，保持持久任务幂等、断连不取消和连续会话。
- 一个中文 Skill 与六个按需引用模块，安装器保留本地修改、记录归属、失败回滚，固定 Release 校验更新。
- Provider 协议不变；scope hash/知识库名称从私有 profile 配置，未新增 capacity 元数据。
- 全仓首轮 879 passed / 6 optional skipped；新增客户端完整专项 8 passed。真实 Provider 路由集成通过。
- 真实 Codex CLI 在隔离 CODEX_HOME 下完成两次 setup、get 与 uninstall；没有修改用户 Codex 配置。
- 发布包解包后 npm ci --ignore-scripts --omit=dev、CLI help 通过；shrinkwrap 随包携带。
- NOT RUN：真实 IMA 提问与回答质量对照；当前未提供本任务专用 Provider 凭据。
- 未发布客户端版本、未部署 Provider；Release workflow 仅在 agent-v 标签推送后生成草稿。
