export type LightpmSummary = {
  /** プロジェクトルート（絶対パス）。ガードの相対パス計算に使う。 */
  root: string
  phase: 'alpha' | 'beta' | 'rc' | 'gm'
  active: { id: string; title: string; priority: string; kind: string; paths: string[] } | null
  counts: { todo: number; in_progress: number; done: number; deferred: number; dropped: number }
  enforcement: 'off' | 'inform' | 'warn' | 'block'
  /** このセッションでガードが検出した範囲外の編集の数。 */
  violations: number
  /** 読み込めなかった .pm/ のファイルの数。 */
  errors: number
}

declare module 'claude-code' {
  interface PluginState {
    lightpm: { summary: LightpmSummary | null }
  }
}
