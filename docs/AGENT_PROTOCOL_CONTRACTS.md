# Agent 协议补强

基于 #23/#32 与当前稳定 main 的隔离候选，不更新已安装 MCP/Skill。

## 新结果字段

webEvidence 保留为布尔值；webEvidenceStatus 可选，取 verified / not_observed / unverified。只按明确网页来源与一致计数判断，能力声明、sourceIntent、process 文案和回答中的搜索声明均不是网页证据。失败／成功状态保持独立，不自动重问。旧终态缓存原样读取且不自动补字段；缺少新字段不能宣称已有证据。新 JSON／Markdown 导出带新字段，原文件保持不变。

status 增加 isolationVerified，只有普通和内部接口均返回与配置一致的 applicationId 才为 true；ready 仍表示兼容的问答可用性，因此 legacy_shared 可以 ready=true、isolationVerified=false。webIntentSupported 来自服务端明确能力标记，新联网任务在提交前检查，既有请求仍按原回执恢复。

## connect-local

新 profile 的选择顺序为 --application-id、安装器 IMA_QA_AGENT_APPLICATION_ID、唯一命名应用；无匹配或多应用歧义直接拒绝。已有 profile 默认保留原应用和 clientId，不能因新的安装器默认值变更所有权。旧 legacy profile 继续复用，新 legacy 连接需明确 --application-id legacy，不自动转换历史。仅复制普通／内部客户端凭据，不复制管理员或 IMA 登录态。

## 合成联调

IMA_PROTOCOL_PROVIDER_CHECKOUT 指向配套 Provider 候选，IMA_PROTOCOL_WEBSITE_CHECKOUT 可指向网站源码；运行 node --test test/agent-protocol-contract-integration.test.js。第一项通过官方 SDK STDIO、实际 Provider 路由和模拟 IMA HTTP/SSE 验证身份、引用、联网、追问和幂等；第二项逐字段对比网站 BFF 与 MCP 的联网开关请求。缺少配套源码时明确 skip，不宣称已联合验收。所有状态、密钥和历史只在隔离临时目录，所有上游发送均由模拟函数接管，不连接真实 IMA。

新电脑此前两轮事件的编号回归仍覆盖 689 种首次出现位置组合，缺少原始上游证据的来源类型仍保留 unknown。#35/#36 原文读取与核验保持独立；本轮已在隔离组合候选进行合成兼容回归，未执行真实材料读取。
