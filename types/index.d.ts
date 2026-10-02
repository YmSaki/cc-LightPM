export type LightpmSummary = {
  phase: 'alpha' | 'beta' | 'rc' | 'gm'
  active: { id: string; title: string; priority: string; kind: string; paths: string[] } | null
  counts: { todo: number; in_progress: number; done: number; deferred: number; dropped: number }
  /** 読み込めなかった .pm/ のファイルの数。 */
  errors: number
}

declare module 'claude-code' {
  interface PluginState {
    lightpm: { summary: LightpmSummary | null }
  }
}
