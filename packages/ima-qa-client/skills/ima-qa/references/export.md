# 导出

使用 CLI `export <task-id> --format markdown --output /绝对路径/research.md`，或 format=json 保存结构化全文。默认拒绝覆盖；用户明确要求替换才加 --force。

终态任务在本地私有 state 目录缓存完整回答和来源，之后可再次导出。Provider 任务事件约 24 小时过期，会话历史也有保留时间和来源数量限制，及时归档。eventsExpired=true 或 complete=false 时不能声称导出完整证据；不要用历史摘要伪装原始完整结果。
