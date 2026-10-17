# IMA 能力合同目录 v1

本目录以操作合同组织能力，不按 URL 数量估计成熟度。机器目录为 [ima-capabilities.v1.json](../contracts/ima-capabilities.v1.json)，固定基线 Provider main 286653e5e08679d7534172c0188831c01310668d。

采用 NotebookLMpy 的“观测、解码、实现、测试、文档”方法：[固定版本开发指南](https://github.com/teng-lin/notebooklm-py/blob/4188d7e26a07b6b94b67bf95041c81bc1530c508/docs/rpc-development.md)。本项目仍使用自身 Node 22 服务，不依赖 NotebookLM 或其凭据。

## 证据分级

发现依据、合成测试、真实验收和发布状态分别记录。已有实现不代表当前 Provider A 路径启用；OpenAPI 仍使用独立身份。历史验收只覆盖记录中的机器、账号配置与操作范围，不能推广成所有账号全部通过。候选实现 #34/#35 未合并，真实材料读取未验收。

目录不参与执行、不注册新 MCP 工具、不改变能力声明；全部条目的 callableFromCatalog 均为 false。没有证据的请求字段、身份或完成条件进入 unknowns，并带有下一步验证动作。

| 能力 ID | 发现／实现范围 | 合成 | 真实 | 发布 |
| --- | --- | --- | --- | --- |
| `auth.login` | 本仓已有实现 | covered_by_tests | pending | published |
| `auth.refresh` | 本仓已有实现 | covered_by_tests | pending | published |
| `knowledge.scope` | 本仓已有实现 | covered_by_tests | pending | published |
| `session.create` | 本仓已有实现 | covered_by_tests | historical_scoped | published |
| `session.followup` | 本仓已有实现 | covered_by_tests | historical_scoped | published |
| `qa.stream` | 本仓已有实现 | covered_by_tests | historical_scoped | published |
| `qa.process` | 本仓已有实现 | covered_by_tests | pending | published |
| `qa.suggestions` | 本仓已有实现 | covered_by_tests | pending | published |
| `citation.web` | 本仓已有实现 | covered_by_tests | historical_scoped | published |
| `citation.knowledge` | 本仓已有实现 | covered_by_tests | pending | published |
| `qa.web_intent` | 本仓已有实现 | covered_by_tests | historical_scoped | published |
| `material.resolve` | 未合并候选实现 | external_candidate_tests | pending | unpublished |
| `material.read` | 未合并候选实现 | external_candidate_tests | pending | unpublished |
| `knowledge.get` | 本仓已有实现 | covered_by_tests | pending | published |
| `material.list` | 本仓已有实现 | covered_by_tests | pending | published |
| `mode.quick` | #45 候选实现 | external_candidate_tests | historical_scoped | unpublished |
| `mode.deep` | #45 候选实现 | external_candidate_tests | historical_scoped | unpublished |
| `model.list` | #45 候选实现 | external_candidate_tests | historical_scoped | unpublished |
| `model.select` | #45 候选实现 | external_candidate_tests | historical_scoped | unpublished |
| `report.create` | 公开脚本候选 | not_run | pending | unpublished |
| `report.status` | 公开脚本候选 | not_run | pending | unpublished |
| `report.download` | 公开脚本候选 | not_run | pending | unpublished |
| `report.cancel` | 公开脚本候选 | not_run | pending | unpublished |
| `ppt.create` | 公开脚本候选 | not_run | pending | unpublished |
| `ppt.status` | 公开脚本候选 | not_run | pending | unpublished |
| `ppt.download` | 公开脚本候选 | not_run | pending | unpublished |
| `ppt.cancel` | 公开脚本候选 | not_run | pending | unpublished |
| `podcast.create` | 公开脚本候选 | not_run | pending | unpublished |
| `podcast.status` | 公开脚本候选 | not_run | pending | unpublished |
| `podcast.download` | 公开脚本候选 | not_run | pending | unpublished |
| `podcast.cancel` | 公开脚本候选 | not_run | pending | unpublished |
| `memory.read` | 待观察 | not_run | pending | unpublished |
| `memory.write` | 待观察 | not_run | pending | unpublished |
| `memory.delete` | 待观察 | not_run | pending | unpublished |
| `knowledge.create` | 公开脚本候选 | not_run | pending | unpublished |
| `knowledge.update` | 公开脚本候选 | not_run | pending | unpublished |
| `knowledge.delete` | 公开脚本候选 | not_run | pending | unpublished |
| `material.upload` | 公开脚本候选 | not_run | pending | unpublished |
| `material.update` | 公开脚本候选 | not_run | pending | unpublished |
| `material.delete` | 公开脚本候选 | not_run | pending | unpublished |
| `knowledge.list` | #45 候选实现 | external_candidate_tests | historical_scoped | unpublished |

## 后续真实探索与候选实现（#45）

在维护者明确授权的独立浏览器空间，完成网页请求观测、Node HTTP 复现和原生 SDK。模型列表／选择、快速／深度和知识库列表这五项，从脚本线索推进为有候选代码与限定真实验收。单库信息、材料列表新增网页身份 variants；原 OpenAPI 身份和主合同保持独立。材料分页两页各 50 条，无重复。

#45 尚未合并，没有注册生产路由或 MCP 工具。真实范围仅一个账号和指定库、DS 快速／深度，其他模型只有目录证据。五次问答提交中四次完整，一次旧解析器深度失败；修复后新会话通过，未重放失败请求。失败 SDK 原始流未捕获，独立浏览器深度完整流已用于定位和回放。原文读取、产物生成、资料写入和长期记忆仍未验收。

runtimeImplemented 仍以本分支实现为准，外部分支的真实样本不表示当前安装已经启用。详见 [SDK 实现与验收](https://github.com/19Chris19/ima-qa-web-agent/pull/45)。

## 本次公开源码探索

匿名读取官网公开资源，未携带 Cookie、未执行脚本、未请求业务接口。两份采样摘要见 [入口脚本](../contracts/evidence/public-bundle-0.json) 和 [功能依赖](../contracts/evidence/public-bundle-1.json)。只提交摘要、公开地址、采样时间、候选路径／后缀及限制，不提交上游脚本正文。

入口脚本有 177 个去重方法后缀和 24 个前缀候选，包括 get_models、get_task_status、download_task_report、cancel_task、资料增删改与播客配置。依赖注入的前缀不能和任意后缀拼接为可用接口；这些数字不代表接通了 177 个接口。PPT、播客等名称可能只是界面、播放或统计代码，memoryCache 也不证明长期记忆 API。

产物创建、轮询、下载和取消分开登记。请求超时不证明上游未接受任务；未经完成／提交证据核对，不自动重放生成或写入。真正的远程取消也不能以本地 Abort 代替。

## 离线工具与维护

`npm run contracts:check` 校验覆盖、实现路径、测试关联、独立验证状态及脱敏样本。

`npm run contracts:inspect -- --bundle-file /private/public.js --source-url https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/fixture.js --sampled-at 2026-10-17T00:00:00Z` 只读本地普通文件，最多 8MiB，不下载、不 eval、不启动浏览器；只接受已允许的公开源码地址作为来源说明。未匹配到字符串也不证明能力不存在。

新增已实现合同必须有脱敏请求／响应样本、真实实现和测试关联。真实验收需另行授权；CI 不通过猜测补全 unknowns。新样本的正文、身份与网址必须使用 Scrubbed／SCRUBBED 和 example 域名，凭据字段禁止进入样本。

## 本轮限制

目录初始只读整理没有扫码、真实问答、材料读取、生成、上传、删除、生产配置变更或发布；后续 #45 的限定真实查询与问答范围见上节。新电脑的旧失败记录缺少原始 IMA 事件，因此其 unknown 来源与联网未观察到证据的历史根因仍不能断定；新的真实样本不能替代旧任务缺失的证据。
