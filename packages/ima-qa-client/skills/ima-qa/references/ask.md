# 问答

1. `ima_qa_status` 检查 ready。零空闲容量可能只代表忙碌，不意味着配置错误。
2. `ima_qa_ask` 传 question、唯一 requestKey、waitSeconds（0–25）。只有明确需要联网时才 sourceIntent=web。
3. 保存返回的 taskId、conversationId、requestKey。queued/running 调 `ima_qa_get_task`，waitSeconds=25；超时保持原任务，不另起请求。
4. 连续追问传原 conversationId，并为新问题生成新 requestKey。
5. 分页 encoding=json 时按 nextOffset 取完、拼接 chunk、解析 JSON。运行中内容会变化，终态后从 offset=0 重新读取；不能拼接跨时刻的活动快照。

CLI 对应 `ask "问题" --request-key <key> --conversation <id> --wait 25 --json`，查询用 `task <id> --wait 25 --json`。退出码 0 的 running 是正常状态。提交响应丢失时使用同一问题、requestKey、profile 重试；服务器幂等记录与本地回执避免重复执行。
