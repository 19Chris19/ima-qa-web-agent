# 从真实网页还原的 IMA 原生 SDK

本轮使用维护者明确授权的 Ego Lite 独立空间。先观察官方网页，再复现 HTTP 请求、提取脱敏样本和实现代码。没有读取或修改生产账号池，也没有部署、安装客户端或更改公开页面。

入口为 `src/ima-web-protocol-client.js` 的 `IMAWebProtocolClient`。这是供可信本机调用方使用的协议原语，不注册 HTTP 路由或 MCP 工具，不自动取得应用的材料权限，不启动浏览器、账号池、持久化 worker 或后台刷新。

## 已接通的操作

| 操作 | 原生路径 | 本轮实证 |
| --- | --- | --- |
| 模型列表 | `/cgi-bin/model_manage/get_models` | 官方页面请求、浏览器 HTTP 复现及 Node SDK 均返回成功 |
| 知识库列表 | `/cgi-bin/knowledge_tab_reader/get_knowledge_base_list` | 公开脚本确认方法和包装结构，Node SDK 验证四类列表 |
| 单库元信息和根目录 | `/cgi-bin/knowledge_tab_reader/get_knowledge_base_home_page` | 官方页面请求及 Node SDK 成功，核对返回库 ID |
| 文件夹材料列表 | `/cgi-bin/knowledge_tab_reader/get_knowledge_list` | 官方文件夹操作和 Node SDK；两页各 50 条，显式 cursor 变化、ID 无重复 |
| 创建绑定会话 | `/cgi-bin/session_logic/init_session` | 官方页面与 SDK；核对 session ID 和返回知识库 ID |
| 快速／深度问答 | `/cgi-bin/assistant/qa` | 官方页面两种模式、Node SDK 两种模式均有完整结果；保留一次修复前的 SDK 深度解析失败 |

这些查询使用网页账号身份。已有 OpenAPI 查询仍保留独立身份和 ID 规则，网页材料 ID 不自动成为 OpenAPI 文档 ID。

## 模型与模式

网页提供的 `sub_model_infos["0"]` 和 `["1"]` 分别与本次快速／深度实发请求一致；本次 DS 家族的 `model_type` 为 3／1，`model_id` 也不同。SDK 使用返回目录中的明确配对，生成稳定 modelRef，按 ref 选择，不能任意提交 model_type 或按数组位置选模型。

目录还返回超出旧 0—100 范围的其他模型类型。它们可以列出和做结构验证；本轮没有对这些模型执行问答，不能据目录声明其账号资格或质量已验收。旧生产调用链的参数范围保持原样。

模型目录有效期为五分钟；新会话绑定库、模型和模式，之后的追问使用同一绑定。缺少浏览器设备上下文时拒绝创建问答会话。uskey 是 JSON 中的不透明字符串，可包含控制字节，原样保留；HTTP 头仍禁止控制字符。

本轮快速／深度对照均关闭联网补充，实发 `enable_enhancement=false`。SDK 中该布尔字段不构成联网成功证据；true 的执行效果没有在本轮验收，现有线上 sourceIntent 策略未改。

## 深度流的新合同

官方深度流包含 `STRUCTURED_BLOCK / blockThinking`。实证有两种精确结构：

- `Data.thinking_message = { Message: string, Status: 1 }`。
- `Data.thinking_message = { Status: 2, Tips: string }`。

外层只接受 `Data`、`Id`、`Type`。新增、损坏或不认识的语义字段仍拒绝。只有显式 `thinkingBlocks=phase_only_v1` 才接纳；默认解析行为保持原样。

SDK 将全部思考帧合并为一次 `process: answer/running`，不输出思考文本或 Tips，不把思考结束当成回答完成，也不把它们算作资料证据。最终仍须收到真实终态；终态之后的思考帧拒绝。原浏览器深度流的 378 个思考帧离线重放成功。

SDK 消耗到流结束、接纳全部允许的迟到元数据后才发出唯一完成事件。只有思考、没有正文时返回 `ima_web_answer_missing`；上游终态之后出现非法语义帧，也不能先对调用方宣布成功。

## 调用示意

```js
const { IMAWebProtocolClient } = require('./src/ima-web-protocol-client');
const sdk = new IMAWebProtocolClient({ headers: privateHeaders, deviceInfo: privateDeviceContext });
const catalog = await sdk.getModels();
const libraries = await sdk.listKnowledgeBases({ groups: [1002] });
const root = await sdk.getLibraryPage({ knowledgeBaseId: authorizedLibraryId });
const page = await sdk.listMaterials({ knowledgeBaseId: authorizedLibraryId, folderId: selectedFolderId });
// modelRef 由操作者从 catalog 的明确记录选择。
const session = await sdk.createKnowledgeSession({ knowledgeBaseId: authorizedLibraryId, modelRef, mode: 'deep' });
for await (const event of sdk.streamAsk({ session, question, clientId: uniqueAttemptId })) {
  consume(event);
}
```

不要把认证头或设备上下文写入源码、命令行参数、输出或 Git。初次登录与设备上下文取得仍依赖浏览器；本轮使用人工授权的捕获上下文，没有验收长期无人值守更新。此 SDK 不刷新凭证，不管理生产实例。

## 资源与恢复边界

每个客户端同时一个请求，无等待队列；元信息读取十秒截止、解压后 JSON 最多 2MiB。材料列表每页最多 50 条，分页由调用方显式执行，不自动遍历知识库。投影不返回原文件／签名下载地址、密码或创建者账号资料。

请求固定到 IMA 第一方路径，禁止重定向和任意 URL。新问答会话必须由同一 SDK 实例创建并验证范围。一次 clientId 已尝试派发就不能重放，传输或解析失败不触发第二次问答。该保护仅为当前进程；跨进程恢复仍应由现有 Provider 持久任务层承担。

## 真实验证与限制

本轮共五次真实问答提交：浏览器快速／深度各一次；SDK 快速一次；SDK 修复前深度一次；修复后在新的独立会话进行深度验证一次。四次已确认完整答案，一次因旧解析器不认识思考块而失败，上游最终状态未知，没有重放失败请求。

修复前 SDK 失败保留脱敏日志；该次 SDK 原始流未捕获，不能声称完整保留。独立的浏览器深度完整原始流已私有保存，并用于定位和回放。修复后的 SDK 深度验证在提交前保存会话回执，并保存原始流及规范化事件。

真实范围只有本次获授权的浏览器账号、一个指定共享库及 DS 快速／深度家族。SDK 快速／修复后深度分别约 12.1／22.9 秒，这是一轮样本，不是性能保证。报告、PPT、播客入口及报告示例分类只作界面观察，没有提交生成任务。

回答保留了明确引用键和材料身份。已查询的目录只是库内子集，未覆盖回答实际引用的材料，尚未完成引用 ID 到具体原文的验证；不能按标题或列表顺序补配。MCP/Skill 的原文读取、原生 Agent 新问答、其他账号／模型、联网开启、报告／PPT／播客、资料写入、长期记忆和正式部署仍未验收。

脱敏 wire 样本见 `test/fixtures/ima-web-native/`；字段和编号来自观测，文本、身份、设备串、游标与版本已替换，集合缩小，不冒充完整原始流。机器证据索引见 [协议记录](protocol/ima-web-native-20261017.json)。
