# 0002 · 一个 key 引发的房间叠加：React 19 remount 清理失效

- 日期：2026-11-06
- 阶段：前端 / 运维
- 范围：`4118949`、`5bb4aa0`（修复）；根因引入自 `d85d94f`（2026-11-05，群主提交）
- 状态：final

## 背景 / 目标

2026-11-06 13:42 群主手工重启生产加载 B01–B05 全量代码后，用户刷新页面并切换房间，报告「切换房间后多个房间叠加，切了 4 个房间主屏被上下分为 4 份」。目标：定位并修复。这是 P0 用户可见事故（触发规则第 4/5 条）。

## 现象与初步假象

- 受控复现：每切一次房，主区多挂一个 `.chat-scroll`（6 次切换 = 6 个列表、消息数累加），与用户描述完全一致。
- **假象一**：monster-tavern「消息从 308 被清到 7」——实际是叠加列表把多个房间的消息混在一个视图里，DOM 计数（616=多房间求和）被误读成单房历史；API 真实返回（27KB ≈ 7 条长消息）一直是 7。**先查响应体，再讲故事。**
- **假象二**：一度怀疑 `listMessages` SQL 跨房串数据、SSE 泄漏、CSS——全部被二分排除。

## 做法（六轮二分，全部真机构建 + 浏览器实测）

复现环境（临时 AC_DATA_DIR + 预置已知消息数的房间）→ 逐层回退源码构建对比：pre-B03 前端复现（排除 B03/B05 回归）→ 回退到 `d85d94f` 之前干净 → d85d94f 的 web 改动内部二分（styles.css / mention 三件套 / App 组逐一排除）→ **最小复现：干净基线只加一个 `key={roomId}` 到 `<MessageList>` 就坏**；同位置 Composer 的 key 无恙（其子树不含 react-markdown）。

## 根因（黑盒归因，注意边界）

`d85d94f` 给 `<MessageList>` 加了 `key={roomId ?? 'no-room'}`。React 19.3.1 在该位置做 key 换树时**不卸载旧房间的 DOM 子树**——fiber 探针实测：React VDOM 只有一个 MessageList，DOM 却有六个（五个孤儿 fiber），控制台零报错。**已证明的**只有「key 是充分条件 + 该子树含 react-markdown 时触发」；「React 19.3.1 remount 清理缺陷」是黑盒归因，React 升级后必须复测（见遗留）。

## 关键决策

- **去掉 MessageList 的 key**（`4118949`）而不是给孤儿 DOM 打补丁：回到 `d85d94f` 之前已验证干净的形态，最小改动；Composer 的 key 保留（remount 干净且切房重置草稿）。
- **置底语义用 effect 承担**（`5bb4aa0`）：key 移除后 `pinnedRef` 跨房保留，实测确认 review 预判的「A 房上翻 → 切 B 落在历史顶部」——按 review 预先给定的方案修：roomId 变化时重置 `pinnedRef.current = true`（声明在滚动 effect 之前）；不重新加 key。另加空列表过渡渲染跳过滚动赋值的守卫（避免 smooth 动画白白重启）。
- 修复期间把叠放界面造成的「数据被清」恐慌与真实变更分开核对：生产库无消息丢失，唯一真实变更是 tmp-diag 房间被删（叠加界面上误操作的最可能场景）。

## 踩坑

1. **DOM 计数会被叠加污染**：`querySelectorAll('.msg').length` 在叠放的页面里数的是所有残留列表之和——单房数据量必须以 API 响应体或直接查库为准。
2. **React 静默失败比抛栈难查一个数量级**：六个 fiber 孤儿零控制台报错，只能靠 VDOM/DOM 双侧计数定位。
3. **headless 浏览器的 smooth 滚动是时序假象源**：`scroll-behavior: smooth` 在 headless 里动画极慢，一度让「修复反而全落顶部」的误判成立；纯逻辑判定必须临时关掉 smooth。
4. **二分的下界要选在「最后一个已知好」**：第一次二分用了 `30a5582`，仍含 `d85d94f` 的 web 改动，白跑一轮后修正到 `17592ee`。
5. 群主的提交（`d85d94f`）与 agent 的提交（B03/B05）混在同一段历史里，「最近改过」不等于「谁改坏」——二分不看归属看证据。

## 验证

- 复现矩阵：干净基线 scrolls=1；只加 MessageList key → scrolls 随切换次数增长；去掉后恒 1。
- 修复后（关 smooth 纯逻辑）：fresh 进房=底部、A 上翻→切 B=底部、切回 A=底部、连切 6 次 scrolls 恒 1、角色库往返 ×3 无残留（unmount 路径本就干净，证实问题只在 key-remount）。
- `pnpm typecheck` 0；`pnpm test` 九套件全绿；`pnpm build` 0；生产按请求读 dist，用户强刷即生效，无需重启服务。

## 遗留

- 「React 19.3.1 remount 留孤儿 DOM」为黑盒归因：React / react-markdown 升级后需用最小复现（干净基线 + 单 key + 含 markdown 的列表）复测。
- 无自动回归护栏（`pnpm test` 不含浏览器用例）；本篇 devlog + App.tsx 注释是仅有的防线。
- tmp-diag 房间删除（叠加期间误操作）如需恢复，取证快照在 `workspace/db-forensic-142557`（gitignore 内，不入库）。

## 如果重做一遍只改哪三处

1. 二分下界直接选「最后一个线上验证过的好提交」，不选「功能边界提交」。
2. DOM 侧取证与 React 侧取证（fiber 探针）第一时间同时做，五分钟就能判定「VDOM 一个 / DOM 六个」，省掉两轮代码走读。
3. headless 里做滚动相关验收前，先禁 `scroll-behavior: smooth`。
