# ADR-0004：claude 适配器只调本地 CLI，模型供给交给环境层

- 状态：已接受
- 日期：2026-10-30（回溯记录，决策形成于 claude 适配器接入期，提交 `b7c5447`）

## 背景

接入 Claude Code 时有两个问题：agent-crowd 侧怎么调它（代码层），以及 claude CLI 实际打到哪个模型（供给层）。供给层当时有两条路。

## 候选方案

- **A. 内置代理/路由**（如经 cc-switch 之类的本地代理工具，或 agent-crowd 自己做模型映射）：把模型供给逻辑做进产品。
- **B. agent-crowd 只负责 `claude -p ...` 一条命令**，模型供给完全由用户级环境决定：`ANTHROPIC_BASE_URL` 指向哪个兼容端点、`ANTHROPIC_DEFAULT_SONNET_MODEL` 等环境变量把 sonnet/opus/haiku 别名映射到什么真实模型，都是部署环境自己的事。

## 决定

选 B。适配器代码（`harnesses/claude.ts`）不含任何端点、任何模型映射；`--model` 参数只是透传角色配置的字符串。

## 后果

- **收益**：适配器与模型供给解耦——本机实测用 anthropic 兼容端点把别名映射到 deepseek 系模型，换网关/换模型只改环境变量，agent-crowd 零改动；契约面小（`is_error` 兜底这类 CLI 契约问题才是代码要管的，见 devlog 0001）。
- **代价**：`listModels()` 只能给 `['sonnet','opus','haiku']` 这样的**别名**列表，用户在下拉里看到的不是真实模型名——纯显示层问题，已知、可接受（review 已确认语义正确）。
- **运维注记**：正因为供给在环境层，「本机模型现状」这张表（README）是实测快照、会过期，以 `/api/health` 为准。
