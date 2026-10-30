#!/usr/bin/env node
/**
 * devlog 工具：草稿生成 / 索引重建 / 必填小节校验。
 *
 *   node scripts/devlog-draft.mjs                    # 从 .state.json 的 lastSha..HEAD 生成草稿骨架
 *   node scripts/devlog-draft.mjs <since>            # 指定起点 sha（到 HEAD）
 *   node scripts/devlog-draft.mjs --index            # 重建 docs/devlog/README.md 的索引表
 *   node scripts/devlog-draft.mjs --check            # 校验正式 devlog（挂 npm run docs:check）
 *
 * 规则见 docs/devlog/README.md。正式篇文件名形如 0001-<slug>.md，草稿为 0002-draft-<date>.md；
 * 定稿 = 去掉文件名里的 draft-，编号保持不动。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEVLOG_DIR = join(ROOT, 'docs', 'devlog')
const README = join(DEVLOG_DIR, 'README.md')
const STATE_FILE = join(DEVLOG_DIR, '.state.json')

/** 必填小节（前缀匹配 section 标题文本，允许「背景 / 目标」这类带后缀的写法）。 */
const REQUIRED = ['背景', '做法', '关键决策', '踩坑', '验证', '遗留', '如果重做一遍']

/**
 * 参数以数组直传（不走 shell）——`--pretty=format:%h|%ad|%s` 里的竖线
 * 在 Windows cmd 下会被当成管道拆命令，这是实测踩到的坑。
 */
function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  }
  return String(result.stdout).trim()
}

/** 正式篇：0001-xxx.md（排除 draft- 与 README/.state.json）。 */
function formalEntries() {
  return readdirSync(DEVLOG_DIR).filter((f) => /^\d{4}-(?!draft-)[^/]+\.md$/.test(f)).sort()
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state) {
  state.lastRecordedAt = new Date().toISOString()
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function nextNumber() {
  const nums = readdirSync(DEVLOG_DIR)
    .filter((f) => /^\d{4}-/.test(f))
    .map((f) => Number(f.slice(0, 4)))
  return Math.max(0, ...nums) + 1
}

function draft(since) {
  const log = git(['log', '--reverse', '--date=short', '--pretty=format:%h|%ad|%s', `${since}..HEAD`])
  const commits = log ? log.split('\n').map((line) => line.split('|', 3)) : []
  const head = git(['rev-parse', '--short', 'HEAD'])
  const num = String(nextNumber()).padStart(4, '0')
  const today = new Date().toISOString().slice(0, 10)
  const file = join(DEVLOG_DIR, `${num}-draft-${today.replaceAll('-', '')}.md`)

  const commitTable = commits.length
    ? commits.map(([sha, date, subject]) => `| ${sha} | ${date} | ${subject} |`).join('\n')
    : '|（无新提交——考虑改用手工编号或检查范围）|'
  const commitHeader = commits.length
    ? `| sha | 日期 | 主题 |\n| --- | --- | --- |`
    : ''

  const body = `# ${num} · （标题待填）

- 日期：${today}
- 阶段：（待填：功能 / 运维 / 重构 / 文档 …）
- 范围：${since}..${head}（${commits.length} 个提交）
- 状态：draft（定稿时去掉文件名里的 draft-，并跑 --index 重建索引）

## 背景

<!-- TODO：这轮之前世界是什么样的，为什么要有这轮改动 -->

## 做法

<!-- TODO：怎么做的；证据和过程，不要只写结论 -->

## 关键决策

<!-- TODO：有 A/B 的地方写清楚为什么选 B，链到 ../adr/NNNN-*.md -->

## 踩坑

<!-- TODO：哪些地方和直觉不一样、浪费了时间 -->

## 验证

<!-- TODO：怎么证明它 work：命令、输出、证据链 -->

## 遗留

<!-- TODO：本轮没做的、留给下轮的 -->

## 如果重做一遍，只改三处

1.
2.
3.

---

### 提交清单（自动生成，仅作参考，按阶段记不逐 commit 记）

${commitHeader}
${commitTable}
`

  writeFileSync(file, body, 'utf8')
  writeState({ ...readState(), lastSha: head, lastSubject: git(['log', '-1', '--pretty=%s']) })
  console.log(`draft written: docs/devlog/${file.split(/[\\/]/).pop()}`)
  console.log(`state updated: lastSha=${head}（草稿已生成，填完空去掉 draft- 即为定稿）`)
}

function rebuildIndex() {
  const entries = formalEntries()
  const rows = entries.map((f) => {
    const text = readFileSync(join(DEVLOG_DIR, f), 'utf8')
    const title = text.match(/^# \d{4} · (.+)$/m)?.[1]?.trim() ?? f
    const date = text.match(/^- 日期：(\d{4}-\d{2}-\d{2})/m)?.[1] ?? '?'
    return `| ${f.slice(0, 4)} | ${date} | [${title}](${f}) |`
  })
  const table = ['| # | 日期 | 篇目 |', '| --- | --- | --- |', ...rows].join('\n')
  const marker = /<!-- INDEX:BEGIN -->[\s\S]*?<!-- INDEX:END -->/
  const readme = readFileSync(README, 'utf8')
  // 幂等：内容没变化时 replace 结果与原文相同，不能拿「updated === readme」当失败信号。
  if (!marker.test(readme)) {
    console.error('README.md 里找不到 <!-- INDEX:BEGIN/END --> 标记，未改动')
    process.exit(1)
  }
  writeFileSync(README, readme.replace(marker, `<!-- INDEX:BEGIN -->\n${table}\n<!-- INDEX:END -->`), 'utf8')
  console.log(`index rebuilt: ${entries.length} 篇`)
}

/**
 * 本地相对链接检查：markdown 链接指向仓库内文件时，文件不存在即报错。
 * href 按 md 语义基于文档所在目录解析；绝对 URL（http: / mailto: / …）与纯锚点跳过。
 */
function checkLinks(label, file, text) {
  const broken = []
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue
    let target
    try {
      target = decodeURIComponent(href.split('#')[0])
    } catch {
      target = href.split('#')[0]
    }
    if (!target) continue
    if (!existsSync(resolve(dirname(file), target))) broken.push(href)
  }
  if (broken.length) {
    console.error(`✗ ${label}: 失效的相对链接：${broken.join(', ')}`)
  }
  return broken.length
}

function check() {
  const entries = formalEntries()
  let bad = 0
  for (const f of entries) {
    const file = join(DEVLOG_DIR, f)
    const text = readFileSync(file, 'utf8')
    const sections = new Map()
    let current = null
    for (const line of text.split('\n')) {
      const match = line.match(/^## (.+)$/)
      if (match) {
        current = match[1].trim()
        sections.set(current, '')
      } else if (current !== null) {
        sections.set(current, sections.get(current) + line + '\n')
      }
    }
    for (const required of REQUIRED) {
      const key = [...sections.keys()].find((name) => name.startsWith(required))
      // 判空前剔除 HTML 注释行：模板生成的 `<!-- TODO：… -->` 不算内容（双保险，配合下方 TODO 正则）。
      const body =
        key === undefined
          ? ''
          : sections.get(key).split('\n').filter((l) => !l.trim().startsWith('<!--')).join('\n')
      if (key === undefined) {
        console.error(`✗ ${f}: 缺必填小节「${required}」`)
        bad += 1
      } else if (!body.trim()) {
        console.error(`✗ ${f}: 小节「${key}」内容为空`)
        bad += 1
      }
    }
    // 模板生成的是 `<!-- TODO：说明文字 -->`（带冒号与说明），只匹配空注释会永远漏检。
    if (/<!--\s*TODO/i.test(text)) {
      console.error(`✗ ${f}: 还有未填的 TODO`)
      bad += 1
    }
    bad += checkLinks(f, file, text)
  }
  // ADR 无小节模板约束，只做链接检查——失效链接同样随篇数累积（devlog 0001 的 ../server 链接教训）。
  const adrDir = join(ROOT, 'docs', 'adr')
  for (const f of readdirSync(adrDir)) {
    if (!f.endsWith('.md')) continue
    const file = join(adrDir, f)
    bad += checkLinks(`docs/adr/${f}`, file, readFileSync(file, 'utf8'))
  }
  if (bad > 0) {
    console.error(`devlog check: ${bad} 个问题`)
    process.exit(1)
  }
  console.log(`devlog check: ${entries.length} 篇全部合格 ✓`)
}

const arg = process.argv[2] ?? ''
if (arg === '--index') rebuildIndex()
else if (arg === '--check') check()
else if (arg === '' || /^[0-9a-f]{4,40}$/i.test(arg)) draft(arg || readState().lastSha)
else {
  console.error('用法：devlog-draft.mjs [sinceSha | --index | --check]')
  process.exit(1)
}
