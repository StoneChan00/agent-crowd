import { resolveCannbot } from './bins.ts'
import { createOpencodeLikeAdapter } from './opencodeLike.ts'

/**
 * CANNBot is an opencode fork (same CLI + JSON event stream), so it shares the
 * opencode adapter. Its auto-approve flag is `--dangerously-skip-permissions`.
 */
export const cannbotAdapter = createOpencodeLikeAdapter({
  id: 'cannbot',
  label: 'CANNBot',
  resolve: resolveCannbot,
  autoApproveFlag: '--dangerously-skip-permissions',
  missingHint:
    '找不到 cannbot 可执行文件。请确认 `cannbot` 已安装，或用环境变量 AC_CANNBOT_BIN 指定 cannbot.exe 的完整路径。',
})
