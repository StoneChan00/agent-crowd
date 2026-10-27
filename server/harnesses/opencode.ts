import { resolveOpencode } from './bins.ts'
import { createOpencodeLikeAdapter } from './opencodeLike.ts'

export const opencodeAdapter = createOpencodeLikeAdapter({
  id: 'opencode',
  label: 'opencode',
  resolve: resolveOpencode,
  autoApproveFlag: '--auto',
  missingHint:
    '找不到 opencode 可执行文件。请确认 `opencode` 在 PATH 中，或用环境变量 AC_OPENCODE_BIN 指定 opencode.exe 的完整路径。',
})
