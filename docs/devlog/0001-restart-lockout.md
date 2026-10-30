# 0001 · 三次没发生的重启：日志句柄锁与脱离进程存活

- 日期：2026-10-30
- 阶段：运维
- 范围：`3d689fc..b7c5447`（9 文件，claude/codex 适配器接入）
- 状态：final（第四次重启结果见文末「后续」）

## 背景 / 目标

`b7c5447` 提交了 claude/codex 适配器（含 review 发现的 `is_error` 兜底缺陷修复：[claude.ts:153-161](../../server/harnesses/claude.ts)）。生产 server 用 `tsx server/index.ts` 跑、**无 watch**，代码要生效必须重启 8787。目标看似简单：让 server 加载新代码。结果重启连续三次「调度了、但从未发生」，成为一个完整的取证案例。

## 做法

取证 → 修复 → 验证三段式：先用三处硬证据（监听进程 StartTime、日志内容、文件 mtime）确认「重启从未发生」，再用写模式探测复现句柄锁（根因一），据此写 `start-server-8787.ps1`（独立时间戳日志）与 `restart-and-verify.ps1`（六阶段带心跳验证），干跑通过后改用系统级调度（Task Scheduler）执行第四次重启。详细时间线与根因见下两节。

## 时间线（三次失败）

| 时间 | 调度方式 | 结果 |
| --- | --- | --- |
| 10-26 00:35 | `scripts/restart-8787-delayed.ps1`（90s 延迟） | **成功**——但这是运气，见下文 |
| 10-30 21:09 | 同上脚本，WMI 脱离调度（pid 25452） | 90 秒睡眠期内**无声死亡**，零输出 |
| 10-30 21:25 | canary 版（pid 1180），每步写日志 | 日志停在 `woke, invoking restart-server.ps1` 后死亡 |
| 10-30 21:44 | 修复版 `restart-and-verify.ps1`（pid 4244），独立时间戳日志 | 日志只有 `BEGIN`，死在 phase0 的 40 秒 sleep 里 |

## 根因一（已实证）：`*>` 重定向撞现役进程的日志写句柄

两个旧重启脚本都 `*> data\server-8787.log`。而这个文件被**现役 server 的祖先链**长期持有写句柄——00:35 那次重启的 wrapper powershell → `pnpm start` → node，启动时用 `*>` 把整个树的前台输出永久接到了这个文件上。任何后来者再 `*>` 同一个文件，`Start-Process` 阶段就抛共享冲突；脚本里 `$ErrorActionPreference='Stop'` 让它**当场死、零输出**——这正是 21:09 无声死亡与 21:25 canary 秒死的原因。

**实证**：以写模式探测该文件立即抛 sharing violation；`data\server-8787.log` 内容始终停在 00:37 那次重启（若 21:25 真跑过，里面该是新 pid）；8787 监听进程 StartTime 始终是 00:37:14。

00:35 那次为什么能成？再上一代 server 是交互终端启动的，没占这个文件——**成功是巧合，不是设计**。

顺带纠正一个中间误判：曾怀疑「重启扫掉了在飞回合」（00:37 的 startup sweep 确实扫了 1 个回合），但 DB 查证当时那个回合是正常 `done` 结束、完整消息已落库，群里看到的截断只是历史展示压缩。**先查库，再讲故事。**

## 根因二（推断，四次尝试验证中）：脱离进程活不过调度回合

21:44 的修复版已完全绕开根因一（`BEGIN` 心跳成功落盘），仍死在 40 秒 sleep 内。三个旧尝试全部死在「延迟窗口」里、而干跑（verifyOnly，10 秒内跑完）全部存活——指向**从 bash 工具会话里 WMI 脱离式启动的进程，活不过该工具调用的清理窗口**（21:09 无声死亡、21:25、21:44 三案同模式；00:35 成功是因为当时的调度回合结构不同）。该结论尚无直接抓拍，第四次尝试改用系统级调度（Task Scheduler）验证，见下文。

## 关键决策

- **独立时间戳日志**（`start-server-8787.ps1`）：每次启动写自己的 `data\server-8787-<stamp>.log`，根治「新旧进程抢同一文件句柄」这类问题；最新路径镜像到 `server-8787-latest.txt`。
- **按端口杀、绝不按 pid 杀**：`Get-NetTCPConnection -LocalPort 8787` 找监听者再 taskkill 树杀，pid 记录会过期、会被复用。
- **drain 语义**：重启前等所有房间空闲（最多 240s），等不到就 ABORT 并**保留旧 server**——重启永远可重试，宁可不重不打断在飞回合。曾评注过「不要从正在发言的回合里调度重启」，drain 是它的工程化。
- **六阶段验证内建**：sleep → drain → 杀 → 起 → health 探针（claude/codex 必须 available）→ **真实 claude 回合探针**（临时房间、回复必须 `VERIFY-OK`、`exitCode=0`、无 error、房间自动清理），全程 Add-Content 心跳，ABORT/FAIL/PASS 三态落日志。
- 验证产物临时房间（8790 隔离实例数据目录等）确认进程死透后整体清理（[ADR-0003](../adr/0003-workspace-scratch-dir.md) 的暂存区纪律）。

## 踩坑

1. `$ErrorActionPreference='Stop'` + `*>` 共享冲突 = **零输出死亡**，比抛栈更难查；脱离脚本必须每一步先写日志再做事。
2. WMI `Win32_Process.Create` 名义脱离，但在工具会话的清理窗口内并不可靠（三案同模式，见根因二）。
3. 「重启扫掉在飞回合」这类归因要先查 DB 再下结论，展示层截断会制造幻象。
4. 延迟重启的「延迟」挡不住调度者自己的长回合：**验收要放新回合，或交给另一个 agent**。

## 验证

- 写模式探测 `server-8787.log` 复现共享冲突（根因一实证）；
- 干跑（verifyOnly）六阶段全链 PASS：claude 回合 5.2s 回 `VERIFY-OK`、`exitCode=0`、临时房间自动清理；
- `npm run typecheck` 通过（配套 is_error 修复的 typeof 守卫）；
- 三次失败各有日志/进程/文件 mtime 三方证据链（见根因一）；
- **第四次**：改用 Task Scheduler 系统级调度 `restart-and-verify.ps1`，结果于下条 devlog 补记（失败路径已有 8790 e2e + 静态推演兜底）。

## 遗留

- 重启仍依赖手动调度；没有常驻看门狗 / supervisor 自愈（可选演进：`start.ps1` 带 while 循环重启）。
- 三适配器共有残余缺口：CLI 先吐部分正文再非零退出（崩溃/被杀）时 `error` 仍为空 → 记 done 并接龙，与 orchestrator `:485` 注释语义不符（review 记录在案，待统一兜底）。
- `claude.ts listModels` 的 sonnet/opus/haiku 别名仅显示层问题（[ADR-0004](../adr/0004-claude-model-supply.md)），留待单独提交。
- 根因二的直接抓拍（哪个环节杀掉了脱离进程）没有拿到，只留了行为模式证据。

## 如果重做一遍，只改三处

1. **启动脚本从第一天就写独立时间戳日志**——`*>` 固定文件名是句柄锁的种子，没有例外。
2. **所有延迟执行用 Task Scheduler 这类系统级调度**，不做「进程内 sleep + 自以为脱离」的调度；调度者进程的寿命不是你能控制的。
3. **重启/部署验收从第一天就自动化成探针脚本**（health + 真实回合），并永远在**新回合**里做验收——验收动作和被验收对象在同一回合里，注定互相打断。

## 后续（第四次尝试·补记于同日 22:05）

第四次重启已改用**系统级调度**：Task Scheduler 任务 `agent-crowd-restart-8787`（单次触发 2026-10-30 22:21:00、多实例策略 IgnoreNew、Interactive 令牌），由系统服务拉起、不依赖任何工具会话的清理窗口，是对根因二的针对性手段。action 已指向入库后的 `scripts/restart-and-verify.ps1`；截至补记任务尚未触发（LastTaskResult=尚未运行，NextRunTime=22:21:00），8787 仍是 00:37:14 的旧进程。执行结果看 `data\restart-verify.log`（六阶段心跳 + health + 真实 claude 回合探针），由下条 devlog 补记。本次顺带把修复版两件套（`scripts/start-server.ps1`、`scripts/restart-and-verify.ps1`，均已参数化硬编码路径）移入 `scripts/` 入库、删除踩坑版 `restart-8787-delayed.ps1`——[ADR-0003](../adr/0003-workspace-scratch-dir.md)「留存要入库」的纪律兑现。
