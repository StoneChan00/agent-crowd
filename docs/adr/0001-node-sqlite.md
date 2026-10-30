# ADR-0001：存储选 node:sqlite，而不是 better-sqlite3 / Postgres

- 状态：已接受
- 日期：2026-10-30（回溯记录，决策实际发生在 2026-10-27 奠基期，见 `server/db.ts` 初始提交 `2f5b75d`）

## 背景

需要一个本地持久层存房间/角色/消息/回合/记忆，部署目标是「个人开发者 Windows 机器上一条命令起服务」，没有运维托管数据库的条件。

## 候选方案

- **A. better-sqlite3**：生态成熟，但需要 node-gyp 原生编译，Windows 上没有 VS Build Tools 时安装即失败，跨机器分发的第一道门槛。
- **B. Postgres / MySQL**：能力最强，但要求常驻服务、连接配置、端口管理，与「双击 start.ps1 就能用」的目标冲突。
- **C. node:sqlite（Node 内置 DatabaseSync）**：Node ≥ 23.4 起内置、无需任何编译；同步 API 与本项目「单房间串行回合」的写入模式天然契合；单文件 + WAL。

## 决定

选 C。

## 后果

- **收益**：零原生依赖（`package.json` dependencies 里没有任何 db 包）；Windows 部署无编译坑；WAL 模式下读写并发对单机场景足够。
- **代价**：同步 API 会阻塞事件循环——对本项目成立（写频极低、查询毫秒级），高并发场景不成立；Node 版本下限被抬到 23.4（README 已标注）。
- **约束回写**：`db.ts` 是唯一 SQL 触点，schema 升级走 `addColumnIfMissing`；如果哪天真要换嵌入式驱动，只动这一个文件。
