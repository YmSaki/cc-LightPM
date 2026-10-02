export type LightpmSummary = {
  phase: 'alpha' | 'beta' | 'rc' | 'gm'
  active: { id: string; title: string; priority: string; kind: string; paths: string[] } | null
  counts: { todo: number; in_progress: number; done: number; deferred: number; dropped: number }
  /** 読み込めなかった .pm/ のファイルの数。 */
  errors: number
}

/** タスク一覧のペインの1行。pm_next が選ぶ順に並ぶ。 */
export type LightpmBoardRow = {
  id: string
  title: string
  kind: string
  priority: string
  /** 実効優先度（依存を考慮した優先度）。 */
  eff: string
  /** active: 作業中 / next: 次にやる順 / blocked: 前提の完了待ち / later: 後回し */
  group: 'active' | 'next' | 'blocked' | 'later'
  note: string | null
  acceptance: string[]
  paths: string[]
  dependsOn: string[]
  body: string
}

declare module 'claude-code' {
  interface PluginState {
    lightpm: {
      summary: LightpmSummary | null
      board: LightpmBoardRow[]
      /** 一覧で展開しているタスクの id。 */
      expanded: string[]
    }
  }
}
