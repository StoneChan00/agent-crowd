# 架构总览（当前形态）

> 本文描述 agent-crowd 的**当前**形态，随演进持续更新；「为什么这么做」见 `docs/adr/`，「什么时候演进的」见 `docs/devlog/`。三处各管一件事，互相只链接不复制。

一句话：**一个网页群聊外壳，每个角色每次发言 = 一次性、无交互的 CLI 子进程调用**。角色之间靠「谁发言后触发谁」接力，状态全部落在 SQLite，进程本身无状态。

## 模块图

```text
                    web/（React + Vite，构建产物由 server 托管）
                          │ REST + SSE
┌─────────────────────────▼──────────────────────────────────┐
│ server/index.ts        Express API + SSE 广播 + 静态托管    │
│   · 启动 sweep：running 标中断+收割孤儿 CLI 树（存 pid）│
│   · listen 后恢复 queued 回合（队列持久化 P0-2）           │
│   · /api/bootstrap /rooms /characters /presets /memories …  │
├────────────────────────────────────────────────────────────┤
│ server/orchestrator.ts 回合编排核心（全部内存态都在这）     │
│   queues/active/chains/rounds 四张 Map + pump() 串行消费     │
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
2. **入队**（`enqueue`）：同房间串行（同一时刻只有一个角色在跑）；接力对「正在跑的同角色」去重防死循环，显式用户意图（@、▶）则允许排队追加。**入队即落库**：每条排队项都是一行 `status='queued'` 的 turn（hop/override/retry/isRoundSummary 一并持久化）——队列与回合记录同表，重启后按行恢复（P0-2）。
3. **消费**（`pump`）：`claimTurn`（compare-and-set `queued`→`running`，防双跑）→ `active.set`（AbortController + 流式 replay 缓冲）→ 广播 `turn running`；角色已删/停用或接力预算 `maxHops` 超限时该行直接置 `stopped`。重启时 `running` 标 error + 收割孤儿进程（宁丢不重），`queued` 原样恢复重跑（restoreQueues 在 listen 后执行，恢复轮不触发轮末总结）。
4. **组 prompt**（`prompt.ts buildTurnPrompt`）：最近 80 条群聊消息按字符预算（18000 字符、单条截断 4000——完整 review/修复汇报必须整条到达；总预算 32000，溢出时只切头部、【现在轮到你】指令永不丢；override 超长同样按单条上限截断，防其借 tail 保护绕过总上限）重放成时间戳对话 + 成员花名册（名字/别名/harness/模型）+ 人设 + 长期记忆（角色跨房间身份记忆 + 房间共享记忆，带预算防挤占）+ override（steer/手动指令）。契约由 `scripts/prompt-check.mjs` 锁定。
5. **调 CLI**（`harnesses/*`）：按适配器契约（见下）spawn 子进程；`onSpawn` 把 CLI pid 存进 `active` 和 turn 行（后者供宕机 sweep 收割孤儿）；流式 `emit` text/thinking/tool 增量，经 SSE `delta` 推给前端，同时进 replay 缓冲（中途加入的客户端可追）。
6. **落库**：
   - 用户 abort → turn `stopped`，半截文本保留为角色消息，`meta.error='已停止'`。
   - `error && 无正文` → turn `error` + 系统警告消息；瞬态失败（`isTransientFailure`：死得快）自动重试**恰好一次**（`item.retry` 循环守卫）。
   - 有正文（可能带 `meta.error`）→ 以角色消息落库，meta 携带 harness/model/turnId/durationMs/exitCode/pid/sessionId/tokens/thinking/tools。
7. **接力**：`!output.error` 时 `enqueueFollowers(hop+1)`；带 error/截断的回合**不接龙**（半成品传给下游比沉默更糟）。
8. **收尾**：队列排空时先过 SOP 门禁（见下节）——无改动轮直接进轮末总结（`onRoundEnd` 角色）；有改动轮必须 review 结论为 PASS 且（若配置了验证命令）服务端自跑验证通过，否则发一条门禁说明后丢弃本轮状态、不总结也不重排队。

## DB（`db.ts`，node:sqlite 单文件，WAL）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `rooms` | working_dir、max_hops、verify_command | 每房间一个工作目录、一个接力上限、一条收尾验证命令（SOP 门禁，空=不跑验证） |
| `characters` | harness、model、persona、triggers、auto_approve、identity_id、preset_id | 房间内角色副本；`identity_id` 绑定跨房间身份记忆 |
| `messages` | author_type、content、meta(JSON) | 群聊流水；meta 里有 exitCode/pid/error/changed（改动证据） 等 |
| `turns` | status、output、error、trigger_message_id、pid、hop、override、retry、is_round_summary、round_id、changed | 一次回合一行；**兼任队列**（P0-2）：入队即插入 `queued`，开跑 claim 转 `running`，结束置终态；重启时 running 标 error+收割孤儿，queued 原样恢复。`round_id`/`changed` 为 SOP 门禁证据（P0-3）。契约由 `scripts/queue-check.mjs` 锁定 |
| `round_checks` | room_id、round_id、kind(review/verify)、verdict(pass/fail)、detail | SOP 门禁审计（P0-3）：每条 REVIEW 结论与每次验证命令的运行结果 |
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
- **SOP 收尾门禁**（P0-3）：一条人类消息/手动运行 = 一轮（`roundId`），改动有证据、review 有结论、验证服务端自己跑——三者共同决定一轮能否收尾。

## SOP 门禁（P0-3：改动证据 / REVIEW 结论 / 验证命令）

一轮（一次人类消息或手动运行触发的整条接力链）要收尾，先过三道闸：

1. **改动证据（3a）**：`pump` 在每个回合前后对 git 工作区各做一次快照（`server/gitstate.ts`，先 `rev-parse --show-toplevel` 解析到仓库根再 `status`——房间 workingDir 通常是仓库子目录，直接在 cwd 跑会漏掉兄弟目录的真实改动）。两次快照的差异落 `turns.changed`（JSON 数组，null=非 git 工作区无法判定）与 `message.meta.changed`，transcript 里渲染成 `[改动: a.ts、b.ts]`（最多 5 个路径），并累积进本轮的 `round.changedPaths`。改动归属按"回合前后工作区变化"计，多房间并发写同一仓库时会互相计入（不承诺按回合精确归属）。
2. **review 结论（3b）**：约定独立成行的 `REVIEW: PASS` / `REVIEW: CHANGES`（允许全角冒号、`**` 包裹、大小写不敏感；代码块/行内代码里不算；`REVIEW: PASSED` 等变体不识别；多条取最后）。`server/sop.ts` 的 `parseReviewVerdict` 解析后写 `round_checks(kind='review')`，轮内以最后一条为准（CHANGES → PASS 视为返修通过）。群聊规则第 9 条告知所有角色。
3. **收尾门禁（3c）**：队列排空时 `maybeStartRoundSummary` 先过 `gateDecision` 真值表——
   - 本轮无改动 → 直接收尾（现状不变）；
   - 有改动但最后结论不是 PASS → 阻断（发一条门禁说明，每轮至多一条）；
   - 有改动 + PASS + 房间配了验证命令（`rooms.verify_command`）且未跑 → **服务端自己跑**（shell 语义、`room.workingDir`、300s 超时、输出尾部 1500 落 `round_checks(kind='verify')`），通过才收尾、失败阻断；
   - 门禁阻断的轮**不自动重排队**（防自锁），继续干活由人/角色的下一条消息发起新一轮。

验证命令运行期间 `gateActive(roomId)` 为真：`/api/rooms/:id/state` 报 `gate: 'running'`，重启排空判定（restart.ts）也把它算作忙，避免重启在验证跑到一半时掀掉进程、静默丢失门禁结果。契约由 `scripts/sop-check.mjs` 锁定（S1 解析器 / S2 真值表 / S3 快照 / S4-S8 端到端 / S9 重启竞态）。
