# 排障

- credential_missing：检查私有配置或 MCP 进程环境。不要输出密钥。
- conversation_not_found/task_not_found：核对 profile、clientId、两类 token 的 application 归属；不要通过随意创建新任务掩盖问题。
- provider_transport_error：连接失败或响应丢失。带 requestKey 的提交只按原值重试；读取失败继续读原 taskId。
- indeterminate：Provider 重启或上游结果不确定；不自动重新提问。
- eventsExpired：完整事件已过期；本地有归档则读归档，否则说明证据缺失。
- operation_locked：可能另一个客户端正在提交同一请求或执行安装。只在确认原进程已退出时删除错误给出的 lockPath，然后重试；不会自动抢锁。
- 登录/资格问题：使用 Provider 既有管理与扫码流程，不把 Cookie 复制给 Agent。
- mcp_name_conflict/modified_skill_conflict：保留现有安装，检查归属与本地修改后处理。
