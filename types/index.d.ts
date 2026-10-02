export type LightpmProgress = { done: number; total: number }

export type LightpmSummary = {
  /** 作業中のタスク（優先度の高い順）。 */
  active: { id: string; title: string; priority: string; progress: LightpmProgress }[]
  /** 最優先の未着手タスク。 */
  top: { id: string; title: string; priority: string } | null
  counts: { todo: number; in_progress: number; done: number; dropped: number }
  /** 読み込めなかった .pm/ のファイルの数。 */
  errors: number
}

/** タスク一覧のペインの1行。 */
export type LightpmBoardRow = {
  id: string
  title: string
  kind: string
  priority: string
  status: 'todo' | 'in_progress' | 'done' | 'dropped'
  /** active: 作業中 / todo: 未着手 / done: 完了 */
  group: 'active' | 'todo' | 'done'
  progress: LightpmProgress
  checklist: { text: string; done: boolean }[]
  /** 前提のタスクと、その状態（未着手、作業中、完了、取り下げ、不明）。 */
  dependsOn: { id: string; status: string }[]
  severity: string | null
  impacts: string | null
  body: string
}

declare module 'claude-code' {
  interface PluginState {
    lightpm: {
      summary: LightpmSummary | null
      board: LightpmBoardRow[]
      /** 一覧で展開しているタスクの id。 */
      expanded: string[]
      /** 一覧で完了済みのタスクを表示するか。 */
      showDone: boolean
    }
  }
}
