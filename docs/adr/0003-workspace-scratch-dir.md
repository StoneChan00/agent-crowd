# ADR-0003：workspace/ 是 git ignore 的运行暂存区

- 状态：已接受
- 日期：2026-10-30（回溯记录，规则始于仓库奠基，见 `.gitignore`）

## 背景

示例房间需要一个默认工作目录让 agent 有地方动手；同时 agent 运行时会产生大量草稿、探针、验证产物（如 `restart-and-verify.log`、临时脚本），这些既不该进版本库，也不该被 linter/构建扫到。

## 候选方案

- **A. 示例房间直接用某个真实源码目录**：agent 一上手就改仓库本体。
- **B. 项目内固定一个 `workspace/` 目录，整目录 git ignore**：沙盒与仓库隔离，示例房间开箱即用；用户把房间工作目录改成自己的真实仓库后，`workspace/` 退化为 agent 的临时暂存区。

## 决定

选 B。`.gitignore` 里 `workspace/`、`data/`（SQLite 与运行时文件）、`*.log` 一并忽略。

## 后果

- **收益**：仓库永远干净（`git status` 只看真实改动）；agent 的验证产物（探针日志、干跑脚本、临时数据目录）落在暂存区里用完即弃，不污染历史。
- **代价与纪律**：落在 `workspace/` 的东西**默认不进版本库**——真正要留存的运维脚本要么移进 `scripts/`，要么接受它只是本机暂存。本仓库现状（2026-10-30 起）：长期运维脚本 `scripts/start-server.ps1`（独立时间戳日志启动）与 `scripts/restart-and-verify.ps1`（六阶段带验证重启）已入库；已证伪的踩坑版 `restart-8787-delayed.ps1`（`*>` 固定日志 + WMI 延迟调度，两次零输出死亡的根因，见 devlog 0001）已删除；纯历史产物（旧 canary / verify 日志）留在 workspace/ 用完即清。这个分寸每次放文件时都要重判一次。
