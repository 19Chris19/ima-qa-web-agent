# 知识库引用证据与原文读取

内部 Agent 证据保留正文显示编号、上游引用键和具体材料身份。公开 `chat_v1` 继续只显示知识库静态角标，不提供材料标题、ID、原文或 IMA 跳转。原文读取是独立能力，映射存在不等于已经读取原文。

## 材料映射

`knowledgeEvidence` 使用 `schemaVersion: 1`：

- `scopeRef`：发起问答的服务端固定知识库 ID 的 SHA-256。
- `materials`：按 `sourceRef` 去重的材料字典，保留 `materialId`、`idNamespace`，以及实际提供的标题、材料类型和所属库。
- `citations`：按 `index:<上游键>` / `context:<上游键>` 保存 `type`、`sourceRefs`、`displayNumbers`。一个引用可对应多份材料，一份材料可被多个引用使用。
- `upstreamPositions`：有界保留上游位置数据，`positionFormat=upstream_opaque`。未经验证的结构不解释成页码、段落或可直接导航的位置。

`sourceRef` 是范围、ID 命名空间和材料 ID 的摘要，不是授权凭证。文件列表只能补充具有相同明确身份的材料信息，不能按列表位置、标题或到达顺序制造引用关联。`media_id` / `mediaId` 和经过验证的文件条目 `id` 保留为网页端 `ima_web_media` 命名空间；不自动声称它们就是 OpenAPI 可接受的 ID。库 ID 也不做数字 ID 与 OpenAPI ID 的猜测转换。

缺失材料 ID 时保留空关联；来源缺少分类依据时仍为 `unknown`。明确的网页/知识库类型冲突会保持 `conflicted=true`，后续更新不能解除。缺失 `conflicted` 字段不补成 `false`。问答成功不依赖材料能否读取。

## 私有保存与接口

任务 JSONL 中的 `knowledge_evidence` 事件仅追加变化的材料和关系。显示编号补齐时只写关系变化；不会重复复制整份材料清单。终态会话归档保存一份规范化证据，用于事件过期后的同任务恢复。原文正文不进入这些问答事件。

默认任务读取、SSE、会话详情及 `chat_v1` 都不输出新增的私有证据字段。过滤私有事件后 SSE ID 可能有间隔，仍保持单调；游标使用服务端真实事件 ID，不按事件数量计算。

配置 `IMA_QA_SOURCE_EVIDENCE_APPLICATIONS_JSON='["ima-agent"]'` 后，同一命名应用的内部服务凭据可读取：

```text
GET /internal/provider-a/tasks/<taskId>?presentation=agent_evidence_v1
GET /internal/provider-a/tasks/<taskId>/events?presentation=agent_evidence_v1
```

任务读取在顶层返回 `knowledgeEvidence`；SSE 额外返回私有增量事件。普通凭据、legacy 身份和未允许的命名应用均不能启用此视图。客户端提供 applicationId 或自定义请求头不能替代服务端 token 映射。新视图仍校验原任务的应用、调用方和 internal scope。

容量接口只向被允许的内部应用报告 `features.knowledge_material_map_v1`。该字段证明接口支持映射，不证明当前某条引用有 ID，更不证明原文已核验。默认授权列表为空。

任务事件过期后，只有同归属、同会话、同 taskId 的仍有效会话轮次可恢复关联。旧归档没有可靠材料身份时继续无法定位，不自动重问、补配或重写旧缓存、导出。

## 验收范围

合成测试覆盖真实 HTTP 路由、JSONL 重启读取、会话重载、事件过期回退、来源乱序/重复/迟到、一对多、显示编号不同于引用键、来源冲突、应用越权及公开投影。它们不证明 IMA 当前会为所有引用返回材料 ID，也不证明网页 ID 与 OpenAPI ID 的兼容性。真实读取和部署需要独立验收。
