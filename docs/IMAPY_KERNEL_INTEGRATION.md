# IMApy 问答内核接入（本地候选，未部署）

第一阶段更新问答协议和页面选择器；第二阶段登录／续期统一尚未执行。
Provider 继续拥有凭证写入、自动维护、资格管理、账号池、队列、应用隔离、历史和任务日志。
没有启动个人 SDK profile、常驻真实浏览器或第二套真实账号池。

## 固定来源与启用条件

`vendor/imapy-core-provenance.json` 固定 IMApy 提交与逐文件 SHA-256，保留 MIT。
当前不需要修改 IMApy 发布版；服务适配在 Provider 实现。最低运行版本为 Node 22。
新路径默认关闭：`IMA_IMAPY_ENABLED=1` 仅在受控验收后启用。
`IMA_IMAPY_MODEL_POLICY_PATH` 可指定独立私有模型策略；默认与会话存储相邻。
默认策略为空：管理员先读取模型目录，再明确保存默认模型与公开允许列表。
默认快速；不静默更换默认模型或关闭联网。不支持当前选择时返回冲突。

设备上下文缺失的账号不参与新内核。可通过 `IMA_IMAPY_DEVICE_CONTEXT_PATH` 指定
经过独立授权取证的本机私有文件（0600、同 UID、非符号链接）：

```json
{"version":1,"accounts":[{"principalFingerprint":"<64位账号身份摘要>","deviceInfo":{"uskey":"<私有设备上下文>","uskey_bus_infos_input":"<私有业务上下文>"}}]}
```

此文件不含账号登录凭证，但仍按私有资料处理。身份摘要必须来自 Provider 已核验账号，
不得按名字、编号或其他账号猜配；损坏、重复或权限不正确时整份设备映射不启用。
本候选只读取，不自动捕获、扫码或写入它。真实部署需另行授权该前置取证。

## 新接口与持久化

- `GET /api/chat-capabilities`；服务间对应 `/internal/provider-a/chat-capabilities`。
  可附 `conversationId`，使用既有普通／内部身份及会话归属；只返回脱敏模型、模式和联网支持。
- 管理员 `GET/PUT /api/admin/model-policy`；`POST .../refresh` 按需核对目录。
  读取目录本身不保存默认模型。策略文件私有原子替换和刷盘；保存失败暂停新内核准入。
- 新页面向原任务 POST 增加 `modelSelection:{modelRef,mode}` 和 `webSearch:boolean`。
  网站 BFF 保留 `sourceIntent`，转换为原内部 `source_intent`；矛盾的选择拒绝。
  旧客户端不带新字段继续使用旧实现；不改 Air 协议。
- 选择进入原任务指纹、待发快照与恢复记录。同键不同选择返回冲突。
  排队后目录过期会重新校验相同模型；删除或失效的模型不会被替换。
- 新会话用 `kernelVersion=imapy_chat_v1`。原账号和上游会话绑定继续保留。
  SDK 私有检查点进现有任务 JSONL，完成时归并会话快照；检查点单步变化经核心验证。
  对外消息只含请求模型／模式与未确认的上游版本，不含检查点、身份或设备数据。
- `selection` 事件及最终 `done`、历史、导出保留请求配置。当前上游解析没有可靠的版本
  确认字段，因此 `reported=null`；页面明确显示“上游模型版本未确认”。
- 派发回执不明保留 pending 检查点并进入 indeterminate，不重问；恢复必须通过核心的
  上游历史、身份、范围、答案摘要及模型类型核对。

## 前端与旧记录

默认页、嵌入页与知天下共用原生 JS/CSS 选择器。桌面使用选择面板；手机使用底部面板。
快捷按钮表示下一次提交，旧回答单独保留当轮配置。支持关闭、焦点返回、原生模态焦点约束、
44px 命中、深色模式和减少动态效果。改变窗口关闭选择面板，保留草稿。
联网按钮不被选择器自动切换；不兼容时禁选并阻止提交。

旧会话继续旧内核，选择器说明需要新会话；不自动搬迁或重写原账号库、历史、缓存和导出。
模型目录加载失败时保留草稿，允许重新打开页面核对，不发送替代问题。

## 本地验证与预览

全部使用隔离临时目录、合成身份和本地模拟上游。`test-support/block-real-ima.cjs`
阻断真实 IMA 网络入口。首次提问、模型／模式切换、同会话与重启恢复、迟到网页引用、
未知派发、身份变更和目录失效均有回归。

```sh
node --require ./test-support/block-real-ima.cjs --test --test-concurrency=2
node --require ./test-support/block-real-ima.cjs scripts/benchmark-imapy-kernel.mjs reports/imapy-kernel-performance.json
node scripts/preview-imapy-kernel.mjs --website /absolute/path/to/website-candidate
```

预览固定 Provider 4590、网站 4591，数据仅在新建临时私有目录；模型名明确标为合成。
关闭预览会清理这些合成数据。不得将真实凭证配置给该脚本。

## 真实验收与部署门槛

真实目录、设备上下文获取、快速／深度、同会话模型切换、联网及重启追问分别设定次数；
未获授权不执行。独立测试通过后再验收真实 Provider 页面与 BFF 全链路。
iOS Safari、Android Chrome 真机与软键盘尚未验收；桌面触屏模拟不能替代。

部署前保留源码和数据备份，排空并核验全局任务／持久化。先兼容后端，再网站和网关，
最后开放已验证的新会话。迁移本机扫码自动匹配修复必须保留。
本机免 token 管理辅助入口若使用静态允许列表，需额外允许 `/model-policy-admin.js`；
本轮未修改该运行中的辅助入口。

功能回退使用本候选保留的旧实现和版本识别保护，关闭新内核开关后排空。
不直接用不认识新版本标记的旧源码覆盖新格式数据。新内核会话保留版本标记与检查点，不交给旧协议重放。
旧会话可继续旧内核，新会话暂停直到对应内核恢复；不回滚凭证或删除未知保护。
第二阶段保留 Provider 自动续期调度与可靠保存，仅逐步统一协议实现，另设跨天验收。
