import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { McpHarnessInfo, McpMap, McpServerInfo } from '../types'
import { Modal } from './Modal'

interface McpPanelProps {
  onClose: () => void
}

/**
 * MCP visibility: which MCP servers each harness CLI currently loads.
 * Data comes from GET /api/mcps, which re-reads the CLIs' own config files
 * (opencode.jsonc / dsh profile patches / claude.json / codex toml) on every
 * request — so the 刷新 button always shows the live config, not a snapshot.
 */
export function McpPanel({ onClose }: McpPanelProps) {
  const [mcps, setMcps] = useState<McpMap | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const data = await api.mcps()
      setMcps(data.mcps)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Modal
      title="MCP 服务器"
      subtitle="各角色 CLI 从自身配置文件加载的 MCP 列表（每次打开实时读取）"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="mcp-foot-hint">
            改配置后点刷新即可看到；opencode / cannbot 共用 ~/.config/opencode/opencode.jsonc
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => void load()} disabled={!error && !mcps}>
            刷新
          </button>
        </>
      }
    >
      {error && <div className="form-error">读取失败：{error}</div>}
      {!mcps && !error && <div className="mcp-loading">读取中…</div>}
      {mcps && (
        <div className="mcp-list">
          {Object.entries(mcps).map(([kind, info]) => (
            <McpHarnessCard key={kind} kind={kind} info={info} />
          ))}
        </div>
      )}
    </Modal>
  )
}

function McpHarnessCard({ kind, info }: { kind: string; info: McpHarnessInfo }) {
  return (
    <section className={`mcp-harness harness-${kind}`}>
      <header className="mcp-harness-head">
        <span className={`harness-chip harness-${kind}`}>{info.label}</span>
        <span className="mcp-count">
          {info.servers.length > 0 ? `${info.servers.length} 个服务器` : '未配置'}
        </span>
        {!info.available && <span className="warn-tag">CLI 未安装</span>}
      </header>
      {info.sources.length > 0 && (
        <p className="mcp-sources" title={info.sources.join('\n')}>
          {info.sources.join('  ·  ')}
        </p>
      )}
      {info.error && <div className="form-error">{info.error}</div>}
      {info.note && <p className="mcp-note">{info.note}</p>}
      {info.servers.length > 0 && (
        <ul className="mcp-servers">
          {info.servers.map((server, index) => (
            <McpServerRow key={`${server.name}-${index}`} server={server} />
          ))}
        </ul>
      )}
    </section>
  )
}

function McpServerRow({ server }: { server: McpServerInfo }) {
  const local = server.type !== 'remote' && server.type !== 'sse' && server.type !== 'http'
  return (
    <li className="mcp-server">
      <span className={`mcp-dot${server.enabled ? ' is-on' : ''}`} title={server.enabled ? '已启用' : '已停用'} />
      <span className="mcp-name" title={server.source ? `来源：${server.source}` : undefined}>
        {server.name}
      </span>
      <span className={`mcp-type${local ? ' is-local' : ' is-remote'}`}>{local ? '本地' : '远程'}</span>
      {!server.enabled && <span className="mcp-off">停用</span>}
      <code className="mcp-detail">{server.detail || '—'}</code>
      {server.timeoutMs !== undefined && (
        <span className="mcp-timeout" title="连接超时">{Math.round(server.timeoutMs / 1000)}s</span>
      )}
    </li>
  )
}
