# 0003 · 从「群聊」到可复核的交付：M3 / B07–B11

- 日期：2026-11-19
- 阶段：可靠性 / 记忆 / 观测 / 隔离
- 范围：`49e6f68`（M3）、`8d29001`（B08）、`ac90933`（B09），B10/B11 见本轮工作区
- 状态：final

## 背景 / 目标

群聊、接力、SOP 门禁和自动提交已经能跑，但真实使用暴露了三个信任问题：

1. **长回合中断**：CLI 静默卡死时一刀杀掉，用户只能重跑；半截产出和诊断信息丢失。
2. **记忆不可信**：自动 episode 只有一条文本，出了问题不知道来自哪一轮；失败教训重复出现也没有升级/过期机制。
3. **结果不可复核**：自动提交只播报 hash，看不到 diff；verify 输出、review 证据、token 消耗散落在不同表；两个房间指向同一仓库时会互相覆盖。

目标不是再加聊天功能，而是让「这一轮到底做了什么、为什么能收尾」可查、可导出，并且多房间同时使用时不会互相踩。

## 做法

- **M3 超时恢复阶梯**：超时后先恢复原 CLI 会话续跑（带超时诊断并禁止原样重跑卡死命令）；无进展则清会话换新会话做一轮纯汇报；仍有进展但再超时则只收尾。连续 3 次熔断。恢复档位落库，重启不降档。
- **B07 技能货架**：新增 `debugging` / `quality-gate` / `cross-agent-handoff`，沿用关键词或 `@skill:` 命中才注入；角色按需勾选，保持模板 skill-neutral。
- **B08 用量与失败教训**：从消息 meta 的 harness usage 聚合房间/角色 token；门禁拦截、verify 失败、回合报错写房间级 `lesson`，最新一条钉选、同 hash 去重。
- **B09 模板与隔离**：三套场景模板一键加角色；房间可创建独立 git worktree + `ac/<room>` 分支，源仓库未提交改动不带入，解除隔离保留分支；共用目录的房间给警告。
- **B10 溯源、生命周期、观测、执行锁**：记忆记录 `source_message_id` / `source_round_id`，UI 可跳回原消息；教训重复 2 次升为常驻，90 天未出现自动降权；新增运行状态抽屉（实时回合、round_checks、crash 日志）；非隔离同目录房间用 ref-count 执行锁串行，verify 也持锁。
- **B11 轮次报告**：自动提交成功时把 hash 写入 `round_checks(kind=commit)`；新增轮次报告接口，聚合回合、改动、交付、token、review/verify/commit 证据，并可按 hash 只读渲染 `git show --stat --patch`，前端可展开 diff、导出 markdown。
- **B11 盲审**：prompt 层提供 `blind` 模式（隐藏聊天记录、记忆、交接和技能）。房间开启「改动后自动盲审」时，有改动的回合会自动把指定 reviewer 排进**同一轮**，只注入原始需求 + 当前未提交 diff，其 VERDICT 直接参与收尾门禁和自动提交；轮次报告里另提供对已提交轮次的事后盲审。
- **B12 重启自愈**：运行中的回合每 2 秒把已流出的文本 checkpoint 到 `turns.output`；重启后 `startupRecovery` 仍然把 running 标成 error，但启动后对有部分产出的中断回合自动排一次续跑（`restart_recovery=1`）：先把部分输出作为带标记的聊天消息放回上下文，再让同一角色带着「从中断处继续」的 override 重跑。零产出、总结回合、同房间还有排队回合时跳过；续跑回合再次被中断也不会二次自动恢复（防循环）。
- **B13 统一 CLI 事件**：`AdapterEvent` 扩展为带结构字段的事件（phase/toolId/toolName/toolInput/toolOk/toolOutput/toolDurationMs），每个适配器通过共享 `timeline.ts` 记录 `CliEvent[]`；`RunOutput.events` 随消息落库，SSE delta 也带上结构化字段。前端新增 `buildCliRows` + `CliTimeline`，按 id 配对 use/result，旧消息回退到 `tools`。每个 adapter 增加 `capabilities`（thinking/tools/tokens/sessionResume）并在就绪面板展示；Claude/Codex 的 token 在适配器边界归一化为总输入（含 cache）。

## 关键决策

- **交付层只读、不复制真相**：轮次报告从 turns/messages/round_checks 现算，不新建 round 表；commit hash 是唯一新增证据行，避免双写漂移。
- **隔离选择 worktree 而不是分支**：分支只隔离提交历史，不隔离工作区；两个房间同时改同一目录仍会互相覆盖。worktree 是结构性解法，分支只是它的副产物。
- **非隔离路径用 ref-count 执行锁**：一次 turn 的 finally 可能与已启动的下一回合或 verify 重叠，单布尔锁会提前释放；计数归零才唤醒等待房间。
- **教训升级阈值取 2、降权取 90 天**：重复一次就说明不是偶发；三个月没再出现说明约定已过时。两个值都是启发式，放在 `server/db.ts` 顶部方便调整。
- **diff 只接受 hash**：接口入参限定 `/^[0-9a-f]{7,40}$/`，不接受路径或任意 git 参数，避免把只读展示变成命令注入面。
- **重启自愈只救「有产出」的回合**：零产出时自动重跑可能重复有副作用的动作，交给用户决定；有部分产出说明任务已经在推进，续跑收益明确。只续一次、不进队列恢复房间，避免重启循环和 RoundState 错位。

## 踩坑

1. **CRLF 让 devlog 校验器全红**：校验器按 `\n` 切行，Windows 文件每行尾带 `\r`，`^## (.+)$` 里的 `.` 不匹配 `\r`，于是所有小节都“缺失”。修校验器（`/\r?\n/`）而不是重写文档——14 个报错其实是一个 bug。
2. **A → B → A 的钉选回退**：失败教训按 hash 复用时如果直接 return，最新一次发生的 A 仍是未钉选，下一轮注入的反而是旧的 B。命中旧行时必须重新钉选并解除其他非常驻教训。
3. **锁的释放时机**：第一个实现用 `active.has(roomId)` 判断是否释放，结果下一回合已由嵌套 pump 启动时锁被外层 finally 提前放掉。改成每次 acquire/release 配对的引用计数。
4. **Windows 子进程测试不退出**：测试脚本 spawn 的 server 被杀后，未消费的 stdout/stderr 管道仍让事件循环存活；改为 `stdio: 'ignore'` 并在结尾显式 `process.exit`。

## 验证

- `npm test` 全绿：sop 147/147、session 127/127、task 53/53、queue 29/29；`lesson-check` 覆盖教训去重/升级/A→B→A、用量聚合、轮次报告；`scenario-check` 覆盖模板、盲审 prompt、worktree 创建/复用/解除、commit diff；`collision-check` 覆盖同目录两房间从不并发、B 排队后自动继续；`blind-check` 覆盖自动盲审进入同一轮、BLIND-OK、门禁放行、自动提交与报告证据；`restart-recovery-check` 覆盖硬杀后的部分输出 checkpoint、自动续跑、原回合 error 与续跑回合完成；`cli-events-check` 覆盖结构化工具事件从 adapter 到 message.meta.events 的落库；`scenario-check` 覆盖时间线配对与旧 tools 回退。
- `npm run typecheck`、`npm run build` 通过。
- 临时仓库 + 临时端口实测模板添加、隔离创建/解除、轮次报告接口。
- 未做浏览器端 E2E；状态面板、来源跳转、diff 展开、导出按钮只过了构建与接口验证。

## 遗留

- 轮次报告目前只覆盖有 `round_id` 的回合；B03 之前的历史轮次没有 round 归属，不会出现在列表里。
- 自动盲审只在**有代码改动**的回合触发；纯聊天轮不需要，也不会触发。
- 事后盲审（轮次报告按钮）仍是咨询性质，不回滚已收尾轮次；真正的门禁结论来自轮前自动盲审。
- `blind` 标记只在内存队列里；服务器在盲审排队期间重启，该回合会退化成普通回合（override 仍在，但会重新带上聊天记录）。
- 重启自愈只续跑有部分文本产出的在飞回合，零产出/总结/有排队回合的房间不续跑；续跑是全新 CLI 会话（完整重放 + 部分输出），不是恢复被杀会话。`AC_RESTART_RECOVERY=0` 可关闭。
- B13 只能展示 CLI 真正上报的数据：DSH 没有结构化工具流和 token，custom 只有 stdout/stderr；能力标记只是把差异说清楚，不补造事件。
- 仓库级共享记忆未做；同一仓库的多个房间目前只共享执行锁，不共享事实。
- 没有鉴权：`AC_HOST=0.0.0.0` 时整个 API（含文件端点）对局域网可读，仍只适合本机/可信网络。

## 如果重做一遍，只改三处

1. 一开始就给记忆加来源字段，而不是先写内容再补溯源——补列容易，补历史来源不可能。
2. 先把「轮次」作为一等数据（或至少稳定 round_id 贯穿 turns/messages/checks），后加报告时不用再从三张表拼。
3. 先修 devlog 校验器的跨平台换行，再写文档；否则会误以为存量文档全不合格，浪费一轮重写。
