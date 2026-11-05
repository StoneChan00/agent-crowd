# 架构总览（当前形态）

> 本文描述 agent-crowd 的**当前**形态，随演进持续更新；「为什么这么做」见 `docs/adr/`，「什么时候演进的」见 `docs/devlog/`。三处各管一件事，互相只链接不复制。

一句话：**一个网页群聊外壳，每个角色每次发言 = 一次性、无交互的 CLI 子进程调用**。角色之间靠「谁发言后触发谁」接力，状态全部落在 SQLite，进程本身无状态。

## 模块图

```text
                    web/（React + Vite，构建产物由 server 托管）
                          │ REST + SSE
┌─────────────────────────▼──────────────────────────────────┐
│ server/index.ts        Express API + SSE 广播 + 静态托管    │
│   · 启动时 sweep 中断回合、收割孤儿 CLI 树（turn 行里存 pid）│
│   · /api/bootstrap /rooms /characters /presets /memories …  │
├────────────────────────────────────────────────────────────┤
│ server/orchestrator.ts 回合编排核心（全部内存态都在这）     │
│   queues/active/chains 三张 Map + pump() 串行消费            │
├──────────────┬─────────────────────────┬────────────────────┤
│ prompt.ts    │ db.ts                   │ harnesses/         │
│ 群聊上下文+   │ node:sqlite 单文件       │ 8 个适配器 + 共享   │
│ 人设+记忆 →   │ WAL 模式                │ 子进程运行时        │
│ 单回合 prompt │ 8 张表（见下）           │ process.ts/bins.ts │
└──────────────┴─────────────────────────┴────────────────────┘
                          │ 一次性子进程
        cannbot / opencode / dsh / hermes / claude / codex / mock / cmd.exe
```

## 一次 turn 的完整生命周期

1. **触发**（`orchestrator.ts`）
   - 用户消息严格按 @ 路由：`@all`/`@所有人` 唤醒全部启用角色；`@名字`/`@别名` 点名；只 @ 了停用角色则发系统提示、不落兜底；没人被 @ 时由第一个启用角色接手（`handleUserMessage`，hop=1）。
   - 角色发言后的接力由触发规则表决定（任何角色发言后 / 指定角色发言后 / 被 @ / 关键词，`shouldWake`），hop 逐层 +1。
   - 特殊入口：手动「▶ 发言」（`runCharacter`）、中途补充 steer（打断在飞回合、保留半截文本，`steer`）。
2. **入队**（`enqueue`）：同房间串行（同一时刻只有一个角色在跑）；接力对「正在跑的同角色」去重防死循环，显式用户意图（@、▶）则允许排队追加。
3. **消费**（`pump`）：`createTurn` → `active.set`（AbortController + 流式 replay 缓冲）→ 广播 `turn running`。接力预算 `maxHops` 超限时清队列并发一次系统提示（`budgetExceeded`，按 hop 计深度，@all 全员都是 hop 1）。
4. **组 prompt**（`prompt.ts buildTurnPrompt`）：最近 80 条群聊消息按字符预算（18000 字符、单条截断 4000——完整 review/修复汇报必须整条到达；总预算 32000，溢出时只切头部、【现在轮到你】指令永不丢；override 超长同样按单条上限截断，防其借 tail 保护绕过总上限）重放成时间戳对话 + 成员花名册（名字/别名/harness/模型）+ 人设 + 长期记忆（角色跨房间身份记忆 + 房间共享记忆，带预算防挤占）+ override（steer/手动指令）。契约由 `scripts/prompt-check.mjs` 锁定。
5. **调 CLI**（`harnesses/*`）：按适配器契约（见下）spawn 子进程；`onSpawn` 把 CLI pid 存进 `active` 和 turn 行（后者供宕机 sweep 收割孤儿）；流式 `emit` text/thinking/tool 增量，经 SSE `delta` 推给前端，同时进 replay 缓冲（中途加入的客户端可追）。
6. **落库**：
   - 用户 abort → turn `stopped`，半截文本保留为角色消息，`meta.error='已停止'`。
   - `error && 无正文` → turn `error` + 系统警告消息；瞬态失败（`isTransientFailure`：死得快）自动重试**恰好一次**（`item.retry` 循环守卫）。
   - 有正文（可能带 `meta.error`）→ 以角色消息落库，meta 携带 harness/model/turnId/durationMs/exitCode/pid/sessionId/tokens/thinking/tools。
7. **接力**：`!output.error` 时 `enqueueFollowers(hop+1)`；带 error/截断的回合**不接龙**（半成品传给下游比沉默更糟）。

## DB（`db.ts`，node:sqlite 单文件，WAL）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `rooms` | working_dir、max_hops | 每房间一个工作目录、一个接力上限 |
| `characters` | harness、model、persona、triggers、auto_approve、identity_id、preset_id | 房间内角色副本；`identity_id` 绑定跨房间身份记忆 |
| `messages` | author_type、content、meta(JSON) | 群聊流水；meta 里有 exitCode/pid/error 等 |
| `turns` | status、output、error、trigger_message_id、pid | 一次回合一行；running 中 server 被杀 → 启动 sweep 依此收割 |
| `character_presets` | 同 characters 语义 | 角色库模板；与房间副本是**快照关系**（互不回写） |
| `identities` | name（唯一索引）、persona | 跨房间身份（同名角色共享） |
| `memories` | scope(identity/room)、owner_id、pinned、use_count | 长期记忆；`pickMemoriesForPrompt` 预算化注入 |
| `meta` | key/value | 杂项 KV |

schema 升级走 `addColumnIfMissing`（`create table if not exists` 不会动已存在的表）。

## 适配器契约（`harnesses/types.ts`）

```ts
interface HarnessAdapter {
  id: HarnessKind
  label: string
  run(input: RunInput): Promise<RunOutput>   // 一次性调用，不常驻
  listModels?(): Promise<string[]>           // 角色编辑器的模型候选
}
// RunInput:  character/room/prompt/cwd/signal/emit/onSpawn
// RunOutput: text/thinking?/toolTraces?/sessionId?/pid?/tokens?/exitCode/durationMs/error?
```

约定：**error 语义是刚性的**——`error && 无 text` 记失败；有 text 时 `error` 只是「可能不完整」的标记，且**阻断下游接龙**。退出码兜底（`code !== 0 && !text`）各适配器各自实现。

| 适配器 | CLI 形式 | 备注 |
| --- | --- | --- |
| cannbot / opencode | `run --format json --model <provider/model> --auto|--dangerously-skip-permissions --dir <cwd> "<prompt>"` | 共用 `opencodeLike.ts`，JSONL 事件流 |
| dsh | `--profile headless --patch <每角色 patch.yml> "<prompt>"` | 每回合生成 patch 覆盖模型；凭据自动回读重试 |
| hermes | `chat --query-file <临时文件> --format stream-json -Q --in <cwd> [--yolo]` | prompt 走文件（Windows 转义） |
| claude | `-p <prompt> --output-format stream-json --verbose [--model M] [--dangerously-skip-permissions \| --permission-mode default]` | `result` 事件 `is_error` 时 error 必置（含 `error_max_turns` 无 error 字段场景） |
| codex | `exec --json --skip-git-repo-check [--dangerously-bypass-approvals-and-sandbox \| --sandbox read-only] [--model M] <prompt>` | `--full-auto` 已弃用，特意不用 |
| mock | 本地无模型 | 验证接力链用 |
| custom | `{prompt}/{model}/{cwd}/{name}` 占位符 → cmd.exe | 兜底自由接入 |

prompt 走 argv 或临时文件、**不经过 shell**（spawn 无 shell，多行/引号安全）；模型映射与凭据供给见各适配器头部注释与 ADR。

## 设计不变量

- **串行回合**：同房间同一时刻只有一个角色在跑，避免多 agent 同时改同一批文件。
- **无状态调用**：每回合全新 CLI 进程，上下文靠重放（记忆是唯一的跨回合携带）。
- **接力预算**：hop 深度计费而非次数，@all 直达全员不占预算。
- **失败不接龙**：带 error 的回合不触发下游。
- **快照式模板**：角色库改模板不回写已加入房间的角色，反之亦然。
