/**
 * B09 contract: scenario templates + opt-in isolation worktrees.
 *
 *   node scripts/scenario-check.mjs
 *
 * S1 templates — fixed allowlist, unique ids/names, usable characters.
 * S2 worktree  — repo-root resolution, dirty source is NOT carried over,
 *                branch creation/re-attach, removal keeps the room's branch.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`✓ ${name}`)
    return
  }
  failed += 1
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- S1: templates --------------------------------------------------------
const { ROOM_TEMPLATES } = await import('../server/room-templates.ts')
const ids = ROOM_TEMPLATES.map((template) => template.id)
const names = ROOM_TEMPLATES.map((template) => template.name)
check('S1 至少有 3 个场景模板', ROOM_TEMPLATES.length >= 3, JSON.stringify(ids))
check('S1 模板 id / name 唯一', new Set(ids).size === ids.length && new Set(names).size === names.length)
check(
  'S1 每个模板角色完整且同名不重复',
  ROOM_TEMPLATES.every((template) => {
    const local = template.characters.map((character) => character.name)
    return (
      template.characters.length >= 2 &&
      new Set(local).size === local.length &&
      template.characters.every(
        (character) =>
          character.name.trim().length > 0 &&
          character.persona.trim().length > 0 &&
          typeof character.harness === 'string' &&
          character.triggers !== undefined,
      )
    )
  }),
)

// --- S1b: blind review prompt -------------------------------------------------
{
  const { buildTurnPromptDetailed } = await import('../server/prompt.ts')
  const { DEFAULT_TRIGGERS } = await import('../server/types.ts')
  const built = buildTurnPromptDetailed({
    room: {
      id: 'r-blind',
      name: '盲审室',
      topic: '',
      workingDir: 'C:/tmp',
      maxHops: 6,
      verifyCommand: '',
      reviewerCharacterId: null,
      isolationSource: '',
      isolationBranch: '',
      createdAt: 0,
    },
    character: {
      id: 'c-blind',
      roomId: 'r-blind',
      name: '审查者',
      aliases: [],
      avatar: '🔍',
      color: '#fff',
      harness: 'mock',
      model: '',
      persona: '你是独立审查者。',
      cwd: '',
      triggers: DEFAULT_TRIGGERS,
      commandTemplate: '',
      autoApprove: true,
      enabled: true,
      identityId: null,
      presetId: null,
      skills: [],
      createdAt: 0,
    },
    characters: [],
    messages: [
      {
        id: 'm-secret',
        roomId: 'r-blind',
        authorType: 'user',
        characterId: null,
        authorName: '你',
        authorAvatar: '',
        color: '',
        content: '机密聊天内容不应出现',
        meta: null,
        createdAt: 1,
        seq: 1,
      },
    ],
    cwd: 'C:/tmp',
    override: '【原始需求】SPEC-TEXT\n\n【Diff】DIFF-TEXT',
    blind: true,
  })
  check(
    'S1b 盲审 prompt 隐藏聊天/记忆，只带需求与 diff',
    !built.prompt.includes('机密聊天内容不应出现') &&
      !built.prompt.includes('最近的群聊记录') &&
      !built.prompt.includes('房间共享记忆') &&
      built.prompt.includes('SPEC-TEXT') &&
      built.prompt.includes('DIFF-TEXT'),
    built.prompt.slice(0, 300),
  )
}

// --- S1c: unified CLI timeline -------------------------------------------
{
  const { buildCliRows } = await import('../server/cli-timeline.ts')
  const rows = buildCliRows(
    [
      { kind: 'tool_use', id: 't1', name: 'Read', input: 'a.ts', at: 1 },
      { kind: 'tool_result', id: 't1', name: 'Read', ok: true, output: 'file body', durationMs: 120, at: 2 },
      { kind: 'tool_use', id: 't2', name: 'Bash', input: 'npm test', at: 3 },
    ],
    undefined,
  )
  check(
    'S1c 工具时间线按 id 配对 use/result',
    rows.length === 2 &&
      rows[0].name === 'Read' &&
      rows[0].ok &&
      rows[0].output === 'file body' &&
      rows[0].durationMs === 120 &&
      rows[1].running,
    JSON.stringify(rows),
  )
  const legacy = buildCliRows(undefined, [
    { id: 'x', name: 'Grep', ok: false, detail: 'no match', durationMs: 5, input: 'needle' },
  ])
  check(
    'S1c 旧消息从 tools 回退渲染',
    legacy.length === 1 && legacy[0].name === 'Grep' && !legacy[0].ok && legacy[0].input === 'needle',
    JSON.stringify(legacy),
  )
}

// --- S2: worktrees --------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'ac-scenario-'))
const repo = join(root, 'repo')
mkdirSync(repo, { recursive: true })
const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git(repo, ['init', '-q'])
git(repo, ['config', 'user.email', 'check@example.test'])
git(repo, ['config', 'user.name', 'check'])
writeFileSync(join(repo, 'tracked.txt'), 'base\n')
git(repo, ['add', 'tracked.txt'])
git(repo, ['commit', '-q', '-m', 'seed'])
// Dirty source: the worktree starts from HEAD, so this file must not appear.
writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n')

process.env.AC_DATA_DIR = join(root, 'data')
const { createIsolationWorktree, removeIsolationWorktree, repoRoot } = await import('../server/worktree.ts')

const normalize = (path) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
check('S2 repoRoot 解析仓库根', normalize(repoRoot(repo)) === normalize(repo))
check('S2 非 git 目录返回 null', repoRoot(join(root, 'nope')) === null)

const ROOM = '11111111-2222-3333-4444-555555555555'
const worktree = createIsolationWorktree({ sourceDir: repo, roomId: ROOM })
check('S2 工作树目录存在', existsSync(join(worktree.path, 'tracked.txt')))
check('S2 分支按 roomId 生成', worktree.branch === 'ac/11111111')
check('S2 工作树检出正确分支', git(worktree.path, ['branch', '--show-current']) === worktree.branch)
check('S2 源仓库未提交改动未被带过去', !existsSync(join(worktree.path, 'dirty.txt')))
check('S2 工作树提交独立于源仓库', git(repo, ['rev-list', '--count', 'HEAD']) === '1')

let duplicateRejected = false
try {
  createIsolationWorktree({ sourceDir: repo, roomId: ROOM })
} catch {
  duplicateRejected = true
}
check('S2 同一房间重复创建被拒绝', duplicateRejected)

removeIsolationWorktree({ worktreeDir: worktree.path, sourceDir: repo })
check('S2 解除后工作树目录消失', !existsSync(worktree.path))
check('S2 解除后分支保留', git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${worktree.branch}`]) === '')

const again = createIsolationWorktree({ sourceDir: repo, roomId: ROOM })
check('S2 再次创建复用已有分支', again.branch === worktree.branch && existsSync(again.path))
removeIsolationWorktree({ worktreeDir: again.path, sourceDir: repo })

// --- S3: commit diff rendering ------------------------------------------
const { showCommit } = await import('../server/gitstate.ts')
const head = git(repo, ['rev-parse', 'HEAD'])
const shown = await showCommit(repo, head)
check('S3 showCommit 返回 stat + patch', shown.ok && shown.text.includes('tracked.txt') && shown.text.includes('+base'))
const rejected = await showCommit(repo, '../etc/passwd')
check('S3 非 hash 输入被拒绝', !rejected.ok)

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: templates + isolation worktrees passed')
}
