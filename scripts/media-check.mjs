// M1 media contract: /api/files serves whitelisted media under room/character
// working dirs (200 + Content-Type, Range 206, 403 outside roots, 404 for
// non-media extensions or missing files), and rewriteMediaLines turns
// `[media] <path>` lines into short markdown links (non-media paths stay
// verbatim). Runs a REAL server against a temp data dir + temp working dir.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mediaFileUrl, rewriteMediaLines } from '../server/media.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const IS_WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`× ${name}${detail ? ` — ${detail}` : ''}`)
    process.exitCode = 1
  }
}

const req = async (port, path, init) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
  return res
}

const freePort = () => 20000 + Math.floor(Math.random() * 18000)

async function bootServer(dataDir) {
  let lastLog = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = freePort()
    const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, AC_DATA_DIR: dataDir, AC_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let log = ''
    proc.stdout.on('data', (chunk) => (log += chunk))
    proc.stderr.on('data', (chunk) => (log += chunk))
    const exitCode = new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
    const deadline = Date.now() + 30_000
    let dead = false
    while (Date.now() < deadline && !dead) {
      const outcome = await Promise.race([
        fetch(`http://127.0.0.1:${port}/api/health`)
          .then((r) => (r.ok ? { state: 'up' } : { state: 'wait' }))
          .catch(() => ({ state: 'wait' })),
        exitCode.then((code) => ({ state: `dead:${code}` })),
      ])
      if (outcome.state === 'up') return { port, proc }
      if (typeof outcome.state === 'string' && outcome.state.startsWith('dead:')) {
        dead = true
        break
      }
      await sleep(200)
    }
    lastLog = log
  }
  throw new Error(`server failed to boot; last log tail:\n${lastLog.slice(-2000)}`)
}

async function hardKill(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (IS_WIN) {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`taskkill exit ${code}`))))
      killer.on('error', reject)
    })
  } else {
    proc.kill('SIGKILL')
  }
  await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(5000)])
}

const servers = []
const tempDirs = []
try {
  /* ------------------------------------------ unit: rewriteMediaLines (pure) */
  {
    const png = 'D:\\projects\\ComfyUI\\output\\img_00001_.png'
    const mp4 = 'D:\\projects\\ComfyUI\\output\\vid_00001_.mp4'
    const bat = 'D:\\projects\\ComfyUI\\output\\run.bat'
    const { text, attachments } = rewriteMediaLines(
      ['开场白', `[media] ${png}`, `[media] ${mp4}`, `[media] ${bat}`, '收尾'].join('\n'),
    )
    check('M1 [media] png → markdown 短链', text.includes(`![img_00001_.png](${mediaFileUrl(png)})`), text)
    check('M1 [media] mp4 → markdown 短链（前端按扩展名分流 video）', text.includes(`![vid_00001_.mp4](${mediaFileUrl(mp4)})`), text)
    check('M1 非媒体扩展名原样保留（不铸可服务 URL）', text.includes(`[media] ${bat}`), text)
    check('M1 attachments 恰含 png+mp4', attachments.length === 2 && attachments[0] === png && attachments[1] === mp4, JSON.stringify(attachments))
    check('M1 非 media 行不动', text.startsWith('开场白\n') && text.endsWith('\n收尾'), JSON.stringify(text))
    const empty = rewriteMediaLines('plain text')
    check('M1 无 [media] 行 → 原文 + 空 attachments', empty.text === 'plain text' && empty.attachments.length === 0)
  }

  /* ------------------------------------------------ e2e: the /api/files gates */
  const dataDir = mkdtempSync(join(tmpdir(), 'ac-media-db-'))
  tempDirs.push(dataDir)
  const work = mkdtempSync(join(tmpdir(), 'ac-media-work-'))
  tempDirs.push(work)
  const outside = mkdtempSync(join(tmpdir(), 'ac-media-out-'))
  tempDirs.push(outside)

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  writeFileSync(join(work, 'shot.png'), pngBytes)
  mkdirSync(join(work, 'nested'))
  writeFileSync(join(work, 'nested', 'clip.mp4'), Buffer.alloc(4096, 7))
  writeFileSync(join(work, 'notes.txt'), 'not media')
  writeFileSync(join(outside, 'escape.png'), pngBytes)

  const { port, proc } = await bootServer(dataDir)
  servers.push(proc)

  const room = await (async () => {
    const res = await req(port, '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'm1-media', maxHops: 4, workingDir: work }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`create room -> ${res.status} ${text}`)
    return JSON.parse(text)
  })()

  {
    const res = await req(port, `/api/files?path=${encodeURIComponent(join(work, 'shot.png'))}`)
    check('M1 白名单内 png → 200 + image/png', res.status === 200 && res.headers.get('content-type')?.startsWith('image/png'), `${res.status} ${res.headers.get('content-type')}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    check('M1 字节与磁盘一致', bytes.equals(pngBytes), `${bytes.length} vs ${pngBytes.length}`)
  }
  {
    const res = await req(port, `/api/files?path=${encodeURIComponent(join(work, 'nested', 'clip.mp4'))}`, {
      headers: { range: 'bytes=0-99' },
    })
    const body = Buffer.from(await res.arrayBuffer())
    check(
      'M1 Range 请求 → 206 + content-range（拖进度条依赖）',
      res.status === 206 && res.headers.get('content-range') === `bytes 0-99/4096` && body.length === 100,
      `${res.status} ${res.headers.get('content-range')}`,
    )
    check('M1 mp4 Content-Type', res.headers.get('content-type') === 'video/mp4', String(res.headers.get('content-type')))
  }
  {
    const res = await req(port, `/api/files?path=${encodeURIComponent(join(work, 'notes.txt'))}`)
    check('M1 非媒体扩展名 → 404', res.status === 404, String(res.status))
  }
  {
    const res = await req(port, `/api/files?path=${encodeURIComponent(join(work, 'missing.png'))}`)
    check('M1 不存在 → 404', res.status === 404, String(res.status))
  }
  {
    const res = await req(port, `/api/files?path=${encodeURIComponent(join(outside, 'escape.png'))}`)
    check('M1 根外路径 → 403（即使扩展名合法）', res.status === 403, String(res.status))
  }
  {
    const res = await req(port, `/api/files?path=${encodeURIComponent(join(work, 'shot.png') + '\\..\\..\\secrets.png')}`)
    check('M1 .. 拼接逃逸不落白名单（403/404 而非 200）', res.status === 403 || res.status === 404, String(res.status))
  }

  const total = passed + failed
  if (failed === 0) console.log(`OK: media contract passed (${total}/${total})`)
  else console.error(`media contract failed (${failed}/${total} failed)`)
} catch (error) {
  console.error(`media contract failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  for (const proc of servers) await hardKill(proc).catch(() => {})
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
}
