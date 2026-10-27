# 跨会话持久身份与共享记忆 · 设计规划

> 状态：PR1 + PR3 已实施（2026-10-26）；PR2（轮末自动提取）与 PR4（embedding 检索）待做。
> 已落地：`identities` / `memories` 表、`characters.identity_id` 同名绑定（改名不换身份）、
> 房间共享记忆 + 角色私人记忆的注入（硬预算 1.2k/0.8k 字符、钉选优先）、
> REST API（`/api/rooms/:id/memories` 系列）、UI（房间设置「团队记忆」、角色编辑「长期记忆」、
> 消息「记住」一键归档）。回答「同一个角色跨房间/跨会话如何保持身份连续，团队如何共享记忆」。

## 1. 现状盘点

| 关注点 | 现状 | 缺口 |
| --- | --- | --- |
| 角色身份 | `characters` 表按房间隔离（`room_id` 外键）；`character_presets` 是全局模板 | 模板只是「出厂设置」：两个房间里的 cannbot 是两个互不相干的实例 |
| 上下文 | `buildTurnPrompt`（`server/prompt.ts`）只注入当前房间最近 80 条消息（约 9k 字符预算） | 跨房间、跨会话完全失忆；清空房间 = 彻底遗忘 |
| 会话 | 每个 turn 是一次 CLI 一击式运行，`sessionId` 仅回填展示 | 没有「同一角色」的连续经历概念 |
| 存储 | `node:sqlite` 单库（WAL），`meta` 表已有 KV 用法 | 无记忆相关表 |

## 2. 目标

1. **持久身份**：同一个角色（如 cannbot）在多个房间、多次会话之间保持连续的自我认知与经历记忆。
2. **共享记忆**：房间/团队级的公共记忆（决议、事实、约定），所有成员发言时都能看到。
3. **可控**：用户可查看、编辑、删除、钉选记忆；写入有硬预算，不会无限膨胀。

## 3. 设计：三层结构

### L1 身份层（identity）

- 新增全局 `identities` 表：`id, name, avatar, color, persona, created_at`——「这是谁」的稳定锚点。
- `characters` 增加 `identity_id`（可空外键）：房间角色绑定身份；角色库 preset 同样挂 `identity_id`。
- 绑定策略：加入房间时默认「同名即同身份」（与现在 name-based trigger 的可移植性思路一致），也允许显式新建身份。
- 迁移成本低：现有 preset 按名字一次性回填 `identity_id` 即可。

### L2 记忆层（memory）

- 新表 `memories`：

  ```sql
  create table memories (
    id text primary key,
    scope text not null,          -- 'identity'（私人） | 'room'（共享）
    owner_id text not null,       -- identityId 或 roomId
    kind text not null,           -- 'fact' | 'decision' | 'preference' | 'episode'
    content text not null,
    source_room_id text,          -- 记忆产生于哪个房间
    pinned integer not null default 0,
    use_count integer not null default 0,
    created_at integer not null,
    last_used_at integer
  );
  ```

- **写入路径**：
  - 手动：UI 上对任意消息/手动输入「记进长期记忆」（PR1 就有，先跑通链路）。
  - 自动：每轮结束后 orchestrator 增加一步「记忆提取」——用最便宜的模型跑一次结构化输出（本轮值得记住的 0~3 条），按内容 hash 去重后落库。
- **读取路径**：`buildTurnPrompt` 注入两段，各自有硬字符预算（建议合计 ≤ 2k，避免挤占 transcript 预算）：
  - `【你的长期记忆】`：该 identity 的 pinned + 最近 N 条；
  - `【房间共享记忆】`：该房间的 decision/fact 最近 M 条。
  - 检索初期用 recency + `like` 关键词，不引入向量库。
- **遗忘与压缩**：identity 记忆超上限（如 200 条）时，把最旧的未固定 episode 摘要合并；`use_count/last_used_at` 供后续淘汰策略用。

### L3 检索增强（可选演进）

- `sqlite-vec` 或本地 bge-m3 做 embedding，语义检索 top-k 注入；
- 记忆置信度与冲突消解：新事实覆盖旧事实时保留版本历史，UI 可回看。

## 4. 实施路线（建议 4 个 PR）

| PR | 内容 | 交付判据 |
| --- | --- | --- |
| PR1 | `identities` 表 + `characters.identity_id` + 迁移；记忆 CRUD API + prompt 注入（仅手动写入） | 同一身份在两个房间发言，能看到对方房间的手动记忆 |
| PR2 | 轮末自动提取（廉价模型）+ 内容 hash 去重 + 写入预算 | 自动记忆条目随轮次增长且无重复 |
| PR3 | 房间共享记忆 + UI（房间设置内「团队记忆」页：增删/钉选） | 多角色 prompt 均含共享记忆段 |
| PR4 | embedding 检索 + top-k + 压缩合并 | 长期运行的房间 prompt 长度稳定 |

## 5. 风险与取舍

- **token 成本**：记忆注入必须硬预算，否则会挤占 9k 的 transcript 预算，让角色「记住了过去、看不清现在」。
- **记忆污染**：错误事实一旦写入会持续影响行为 → 所有记忆可编辑可删除，pinned 视为白名单。
- **并发写入**：多房间同时写同一 identity 的记忆，sqlite 单进程 + WAL 写串行化，无额外处理。
- **隐私边界**：identity 记忆默认跨房间可见；若要「角色在 A 房间不知道 B 房间的事」，把 `source_room_id` 作为过滤条件即可（留作开关）。
