// LightPM の型と定数。コアは入出力を持たない純粋関数だけで書く。

/** 優先度。配列の添字がそのまま序数（xlow = 0 … max = 5）。 */
export const PRIORITIES = ['xlow', 'low', 'mid', 'high', 'xhigh', 'max'] as const
export type Priority = (typeof PRIORITIES)[number]

export const KINDS = ['feature', 'bug', 'refactor', 'polish', 'chore', 'release'] as const
export type Kind = (typeof KINDS)[number]

export const STATUSES = ['todo', 'in_progress', 'done', 'dropped'] as const
export type Status = (typeof STATUSES)[number]

export const SEVERITIES = ['S0', 'S1', 'S2', 'S3'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SCHEMA = 1

/** やることの1項目。done で進捗を表す。 */
export type ChecklistItem = { text: string; done: boolean }

export type Task = {
  schema: number
  id: string
  title: string
  kind: Kind
  priority: Priority
  status: Status
  /** 前提になるタスク。表示するだけで、並び順には影響しない。 */
  depends_on: string[]
  /** やること。進捗は済みの項目の数で表す。 */
  checklist: ChecklistItem[]
  severity?: Severity
  impacts?: string
  /** 直近の更新のメモ。 */
  notes?: string
  created: string
  updated: string
  /** frontmatter の後ろの本文。何をするタスクかの説明。 */
  body: string
}

export type State = {
  schema: number
  nextId: number
}

export type Snapshot = {
  state: State
  tasks: Task[]
}

/** 監査ログの1件。schema / ts / seq / actor は書き込み時に付ける。 */
export type LogEvent = { event: string; [field: string]: unknown }

export const ordinal = (p: Priority): number => PRIORITIES.indexOf(p)

export const isOpen = (t: Task): boolean => t.status === 'todo' || t.status === 'in_progress'

export const progressOf = (t: Task): { done: number; total: number } => ({
  done: t.checklist.filter(item => item.done).length,
  total: t.checklist.length,
})

export const formatId = (n: number): string => `T-${String(n).padStart(4, '0')}`
export const ID_PATTERN = /^T-\d{4,}$/

export const defaultState = (): State => ({ schema: SCHEMA, nextId: 1 })
