# Staged: server-side restart queue（方案①，待 review 后应用）

## 背景与动机（为什么必须换腿）

2026-11-02 两次经计划任务点火 `restart-and-verify.ps1`，进程均以
`0xC000013A`（console-ctrl 类温和终止）静默死亡：

- 13:46:45 BEGIN 后死在 phase0 的 40s 静默窗（加了心跳后可定位）；
- 14:26:39 BEGIN（pid 13852）心跳活到 14:27:09、drain 打到 14:27:38 后死。

第二次死亡前任务设置已确认生效（`Export-ScheduledTask` 复核：
`StopIfGoingOnBatteries=false`、`StopOnIdleEnd=false`、`DisallowStartIfOnBatteries=false`
——battery/idle 嫌疑排除），TaskScheduler Operational 日志禁用（无管理员权限启用），
死因无法定论。**结论：不再加固 Task Scheduler 这条腿。**

同时 drain 在本群结构上必然自锁：busy 的房间就是发起重启的群
（汇报 → review → 回复 → 再次 busy），1500s 一到 ABORT，旧 watch 链原样保留。

## 方案（Deepseek review 建议①：把重启意图交给 server；启动方式按
## E1-E7 实验结论定型为 WMI 启动器，2026-11-03）

server 持有 pending 请求，在接力链**自然终点**（pump() 的 finally，此刻
queues 与 active 全空）这个毫秒级窗口发起重启脚本，随后**驻留继续服务**，
直到脚本 phase2 按端口连 watch 链一起杀掉自己：

- busy 窗口从「等全群永久静默」缩为「接力链之间」；
- **spawn 拓扑（E1-E7 定型）**：任何「server 的子进程」形态都不可用——
  杀自己的 spawn-parent 必然连带自杀（E1/E2a：taskkill 与 .NET Kill 皆然），
  detached（DETACHED_PROCESS）会让 PS5.1 静默不执行任何代码（diag A-F）。
  唯一验证安全形态：server spawn 一个 ~1s 的一次性 launcher（`Invoke-CimMethod
  Win32_Process.Create`）由 WMI 创建**真正的脚本**——WMI 进程在 server 进程树
  中没有父节点，杀链存活（E7 实锤），且全程无 console，0xC000013A 一类
  console 信号死法结构性不可达。launcher 经 `-EncodedCommand` 传参，规避全部
  引号/转义/中文陷阱；powershell 一律绝对路径；
- 检查点全同步（check → notice → spawn 原子执行），新 turn 不可能
  插进中间；唯一可能被中断的 turn 是 `-ExcludeRoom` 明确签约接受的。

### TakeoverPid 契约（P0-1 修复，2026-11-02 第二轮 review）

spawn 时传 `-TakeoverPid <server pid>`，两侧共同保证「杀的确实是 spawn
我们的那条链」：

- **server 侧驻留**：spawn 成功后**不 exit**。若先退，8787 无人监听而
  tsx watch 原地待命，下一个 `server/*.ts` 保存就会拉起第二个 server 抢
  端口——正是要消灭的闭环。驻留期间服务照常，直到脚本杀掉整条链；
- **脚本侧校验**：phase2 杀链前断言 8787 的 listener **正是**
  TakeoverPid——无 listener 或换了 pid（watch 重载过 / 陌生人占口）都
  ABORT，绝不杀别人的链；`-VerifyOnly -TakeoverPid` 可只读预检同一断言；
- **失败语义**：launcher 侧失败（spawn throw / 无 pid / WMI create 拒绝）
  恢复 pending 由下一个自然终点重试；脚本本体 ABORT/FAIL 退出时 server
  只记日志、丢弃请求、继续服务——脚本已经通过 `-NotifyRoom` 把 verdict
  播报到群里，自动重试只会风暴日志（与脚本的 cross-run 锁语义一致）。
- **ABORT 后软窗口解除（P1，2026-11-03 第五轮 review）**：server 侧
  `launchedAt` 软窗口（60min）在脚本 ABORT 后**不会自动解除**——WMI
  fire-and-forget，server 看不到脚本的退出。解除方式：`POST /api/restart`
  带 `"force": true`——只跳过并清零 `launchedAt`，**不**旁路
  `pending`/`launching` 硬防双发（在途请求/launcher 期间仍 409），409 文案
  按真实原因分场景（window 场景点名 force 解法，不再是"已有待执行请求"
  的假理由）。脚本侧配套：ABORT 播报按是否已执行过 taskkill 分场景——
  `$script:Touched` 在 phase2 首次 taskkill 前置位；未击杀=「旧服务未受
  影响」+ force 提示，已击杀=「旧链状态未知，先人工确认再带 force 重排」。
- **并发防护**（P0 修复，2026-11-03 第四轮 review）：`launching` 同步布尔
  ——`maybeRestartNow()` 在 null 掉 `pending` 的同一同步块内置位，直到
  launcher exit/error 回调清除；期间第二个 `POST /api/restart` 立即 409
  （否则在 `pending=null` 与 `launchedAt` 置位之间的 1-3s 空窗里，第二个
  POST 会被接受且被路由里的 `maybeRestartNow()` 立刻再起第二个 WMI 脚本）。
  最后一道防线也补齐：脚本侧锁改为**原子获取**——新锁 `CREATE_NEW`
  （并发恰好一个赢家，实测 6/6）、stale/corrupt 锁先 RENAME claim 再创建
  （实测 claim 双开可双赢，互斥由 CREATE_NEW 保证——绝不用 blind
  Remove-Item，否则可能删掉竞争者刚建的新锁）；
- **phase2 复检**（P1 修复）：kill 重试循环里**每次**重新解析的 listener
  都要复检 `== TakeoverPid`——端口中途换主（watch reload / 陌生人）时
  ABORT，绝不把新主人当原目标杀掉；
- **空击杀防线**：phase2 若 `$killed` 为空（端口本无监听者）绝不打 ok
  ——旧链（幸存 watch）没被清除，直接起新 server 会重建端口竞速；ABORT
  留人工处理。

## 三件套

| 文件 | 内容 |
|---|---|
| `scripts/staged/restart.ts` | 最终落位 `server/restart.ts` 的全文：`requestRestart`（幂等，含 `launching`/`pending`/`launchedAt` 三态防双发 + `force` 软窗口解除、`reason` 分场景 409 文案）、`maybeRestartNow`（全 idle 判定 + 群通知 + 经一次性 launcher 以 `Invoke-CimMethod Win32_Process.Create` 起真脚本并传 `-TakeoverPid`，spawn 前同步校验 `launcher.pid`，失败恢复 pending；成功后**驻留**，launcher exit/error 记日志，WMI 失败回 pending 重试）。 |
| `scripts/staged/apply-restart.mjs` | 应用器：幂等检查 → **轮询 /api/bootstrap 等全空闲**（reload 不打断任何人）→ 唯一锚点替换 orchestrator.ts/index.ts + copy restart.ts → `pnpm typecheck`，失败回滚全部快照。全程落 `data/apply-restart.log`。 |
| 本文档 | review 材料 + 应用与点火流程。 |

orchestrator.ts 改动（2 处，锚点唯一）：

1. `import { buildTurnPrompt } from './prompt.ts'` 之后加
   `import { maybeRestartNow } from './restart.ts'`（循环依赖注释：双方仅运行时调用，ESM 晚绑定安全）；
2. `if (consumed) void pump(roomId)`（finally 末行）之后加 `maybeRestartNow()`。

index.ts 改动（2 处）：

1. `import * as orchestrator from './orchestrator.ts'` 之后加 `import * as restart from './restart.ts'`；
2. sse 段注释前插入两个路由：
   - `POST /api/rooms/:id/system`：system 消息直落库 + SSE 广播，**不触发
     orchestrator**（给脚本③的群播报用；与 startup recovery 的消息形态一致）；
   - `POST /api/restart`：`requestRestart`（重复请求 409）→ 响应后立即
     `maybeRestartNow()`（若本已全 idle 则当场生效）。

## 为什么由外部进程应用（而不是 agent 直接 edit）

改 `server/*.ts` 保存瞬间 tsx-watch reload，reload 会杀 server 及其 spawn 的
在途 turn——包括「正在执行编辑的 agent 自己的回合」（startup recovery 会
taskkill 该 CLI 树）。所以：

1. agent 回合里只做 review/准备，**不直接 edit server/**；
2. review 通过后由 agent 发起一条 detached 命令（见下），它等全空闲再落码，
   reload 打断任何人的概率为 0，连「回合已中断」的系统消息都不会出现；
3. apply 后 typecheck 兜底，失败自动回滚（回滚写入再次 reload 回旧代码）。

## 应用命令（review 通过后由 agent 发起）

```powershell
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','node D:\2_Projects\agent-crowd\scripts\staged\apply-restart.mjs'
```

结果看 `data/apply-restart.log`（ABORT/DONE/rolled back）。

## 点火（apply 成功后）

```
POST http://127.0.0.1:8787/api/restart
{"notifyRoom":"多agent协同"}
```

不带 `excludeRoom`：正常路径等接力链自然止（毫秒级窗口，群内 review 往返
不再阻塞切换）；`excludeRoom` 仅作紧急车道（该房 busy 不阻塞，但在途 turn
会被中断，群会收到预告通知）。点火后 40s 内（phase0）群内请勿发消息；
脚本会向 `notifyRoom` 播报启动预告 + 最终 RESULT。

## 验收清单（真实切换才盖章）

- [ ] `pnpm typecheck` 通过（apply 内置）
- [ ] `POST /api/rooms/:id/system` 实发一条系统消息到群（可先用脚本 VerifyOnly 验证）
- [ ] `POST /api/restart` 返回 `{ok:true, scheduled:'next-idle'}`；第二次立即 POST 返回 409
- [ ] 脚本 ABORT 后：软窗口内普通 POST 得 409 且文案点名 `force:true`；带
      `force:true` 的 POST 被接受；`pending`/`launching` 在途时 force 仍 409
- [ ] ABORT 播报分场景：未击杀路径仍报「旧服务未受影响」；已 taskkill 的
      ABORT 路径（复检 mismatch/5 次未清/强杀后仍活）报「旧链状态未知」
- [ ] server 在 spawn 后**继续服务**（health 仍答 28608），脚本 phase2 才杀掉它：
      restart-verify.log 出现 `takeover target confirmed: listener pid 28608 == TakeoverPid`
      → `phase2 snapshot: oldPid=28608` → phase5 新 pid、祖先链无 watch
- [ ] phase2/phase3 在任何路径上不得出现「零击杀却打 ok」（`$killed` 空 = ABORT）
- [ ] 群里收到 🔵启动预告 + ✅完成播报（notify 路径全通）
- [ ] `data/server-8787-latest.txt` 指向新日志文件
