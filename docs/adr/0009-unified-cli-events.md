# ADR-0009：在 adapter 边界归一化 CLI 事件，前端只保留一个渲染器

- 状态：已接受
- 日期：2026-11-23
- 关联：devlog 0003

## 背景

Agent Crowd 已经支持 8 个 harness，但 `AdapterEvent` 只有 `text/thinking/tool/status` 四种，`toolTraces` 和 `tokens` 由每个适配器自己决定填什么。结果是同一个「详情」面板在不同角色上表现不同：Claude 有工具但没有 thinking，Codex 有截断的 thinking，DSH 有 thinking 但工具列表永远为空，custom 只有 stdout/stderr，opencode 的工具只有 title。用户看到的是同一套 UI，却像在用不同产品。

## 候选方案

- **A. 每个 harness 一套 UI**：最自由，但 8 套渲染器和 8 套测试，后续每个功能都要乘 8。
- **B. 只做展示层兜底**：UI 猜哪些字段可能缺失，缺了就隐藏。差异被掩盖，仍然不知道是 CLI 不支持还是解析漏了。
- **C. adapter 边界归一化 + 能力声明**：结构化事件进入统一契约，CLI 不支持的能力显式标出来。

## 决定

选 C。

- `AdapterEvent` 增加结构化字段；共享 `server/harnesses/timeline.ts` 负责配对 `tool_use`/`tool_result`、生成 `CliEvent[]` 和旧 `ToolTrace[]`。
- `RunOutput.events` 随消息落库到 `message.meta.events`；SSE delta 也带同一组字段，live 与最终消息共用一个渲染器。
- 每个 adapter 声明 `capabilities`（thinking/tools/tokens/sessionResume），`/api/health` 与就绪面板展示；缺失是数据，不是 UI 分支。
- Token 在 adapter 边界归一化：`input` = 总输入（含 cache），cache 字段是子集；Claude/Codex 明确转换，其他 provider 保留其上报语义，未上报则不计。
- 前端 `buildCliRows` 一个纯函数完成配对，`CliTimeline` 一个组件渲染；旧消息只有 `tools` 时回退成一行一个工具。

## 后果

- **收益**：新增 harness 只需实现映射和能力声明，不再碰 UI；用户能看清哪些信息是该 CLI 本身没有的；live 与历史消息的展示一致。
- **代价**：契约字段变多，`AdapterEvent` 不再是严格的四态 union（保留了兼容字段）；DSH/custom 的能力缺口会显式显示为“无”，而不是看起来像 bug。
- **不做**：不伪造事件、不把 custom 的 stderr 猜成工具调用、不为单个 provider 加 UI 分支。
