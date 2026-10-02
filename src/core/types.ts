// LightPM の型と定数。コアは入出力を持たない純粋関数だけで書く。

/** 優先度。配列の添字がそのまま序数（xlow = 0 … max = 5）。 */
export const PRIORITIES = ['xlow', 'low', 'mid', 'high', 'xhigh', 'max'] as const
export type Priority = (typeof PRIORITIES)[number]

export const KINDS = ['feature', 'bug', 'refactor', 'polish', 'chore', 'release'] as const
export type Kind = (typeof KINDS)[number]

export const STATUSES = ['todo', 'in_progress', 'done', 'deferred', 'dropped'] as const
export type Status = (typeof STATUSES)[number]

export const PHASES = ['alpha', 'beta', 'rc', 'gm'] as const
export type Phase = (typeof PHASES)[number]

/** 後回しの解除先。どのフェーズでも着手できないものは post（リリース後）。 */
export type DeferUntil = Phase | 'post'
export const DEFER_REASONS = ['P-FLOOR', 'P-KIND'] as const
export type DeferReason = (typeof DEFER_REASONS)[number]

export const SEVERITIES = ['S0', 'S1', 'S2', 'S3'] as const
export type Severity = (typeof SEVERITIES)[number]

export const ESTIMATES = ['S', 'M', 'L'] as const
export type Estimate = (typeof ESTIMATES)[number]

export const SCHEMA = 1

export type Task = {
  schema: number
  id: string
  title: string
  kind: Kind
  priority: Priority
  status: Status
  depends_on: string[]
  /** 主に触るファイルの目安（作業する側への手がかり）。 */
  scope: { paths: string[] }
  acceptance: string[]
  non_goals: string[]
  estimate?: Estimate
  severity?: Severity
  impacts?: string
  release_blocker?: boolean
  defer?: { until: DeferUntil; reason: DeferReason }
  /** 直近の更新や完了のメモ。 */
  notes?: string
  created: string
  updated: string
  /** frontmatter の後ろの本文（自由記述）。 */
  body: string
}

export type State = {
  schema: number
  phase: Phase
  nextId: number
  active: string | null
}

/** フェーズ × 種別の着手条件。min が null なら種別ごと不可。blocker ならリリース阻害は常に可。 */
export type Rule = { min: Priority | null; blocker?: boolean }
export type Policy = Record<Phase, Record<Kind, Rule>>
export type PolicyOverride = Partial<Record<Phase, Partial<Record<Kind, Priority | null | Rule>>>>

export type Config = {
  schema: number
  policy: PolicyOverride
}

export type Snapshot = {
  state: State
  config: Config
  tasks: Task[]
}

/** 監査ログの1件。schema / ts / seq / actor は書き込み時に付ける。 */
export type LogEvent = { event: string; [field: string]: unknown }

export const ordinal = (p: Priority): number => PRIORITIES.indexOf(p)
export const priorityAt = (n: number): Priority => PRIORITIES[Math.max(0, Math.min(5, n))] as Priority

export const isOpen = (t: Task): boolean =>
  t.status === 'todo' || t.status === 'in_progress' || t.status === 'deferred'
export const isResolved = (t: Task): boolean => t.status === 'done' || t.status === 'dropped'

export const formatId = (n: number): string => `T-${String(n).padStart(4, '0')}`
export const ID_PATTERN = /^T-\d{4,}$/

export const defaultState = (phase: Phase = 'alpha'): State => ({
  schema: SCHEMA,
  phase,
  nextId: 1,
  active: null,
})

export const defaultConfig = (): Config => ({
  schema: SCHEMA,
  policy: {},
})
