# ADR-0002：harness 走一次性 CLI 子进程，而不是直接调模型 API

- 状态：已接受
- 日期：2026-10-30（回溯记录，决策实际发生在 2026-10-27，见 `server/harnesses/` 初始提交 `1065e66` / `0f3e031` / `aa12523`）

## 背景

「角色」需要的不只是会说话的模型，而是**能在工作目录里读代码、改文件、跑命令的 agent**。当时有两条路。

## 候选方案

- **A. 直接调模型 API**：自己实现 tool loop（文件读写、shell、审批 UI）。
- **B. 子进程调各家 CLI**（cannbot / opencode / dsh / hermes / claude / codex）：每个 harness 已经自带完整的工具生态、权限模型、会话管理，agent-crowd 只负责把 prompt 喂进去、把事件流解析出来。

## 决定

选 B。所有调用是一次性、无交互子进程：prompt 走 argv 或临时文件（spawn 不经 shell，Windows 多行/引号安全），流式 JSONL 事件解析为统一的 `AdapterEvent`。

## 后果

- **收益**：6 个 harness 的全部能力（工具、凭据、权限）免费拿到；新 harness 只需实现 40 行的 `HarnessAdapter` 契约；权限策略一维化成每角色一个 `auto_approve` 开关。
- **代价**：进程冷启动开销（每回合数百 ms）；**各家 CLI 的事件契约成为脆弱面**——外部格式变化需要在适配器里兜（例：claude `result` 事件的 `is_error` 不保证带 `error` 字段，`claude.ts` 需专门兜底，见 devlog 0001 修复链）。约定 `error && 无正文` 才算失败、退出码兜底各适配器自实现，这条刚性地写进了 `harnesses/types.ts` 的注释。
- **放弃的东西**：常驻会话（ACP）带来的上下文复用与响应速度。当前用「重放最近 80 条消息」补偿，长期记忆见 `docs/memory-plan.md`。
