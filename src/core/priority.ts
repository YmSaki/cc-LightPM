// バグの優先度の表と、一覧の並び順。

import { ordinal } from './types.ts'
import type { Priority, Severity, Task } from './types.ts'

/** バグの優先度の表。行は影響先の優先度、列は重大度。 */
const BUG_TABLE: Record<'max' | 'xhigh' | 'high' | 'low', Record<Severity, Priority>> = {
  max: { S0: 'max', S1: 'max', S2: 'xhigh', S3: 'mid' },
  xhigh: { S0: 'xhigh', S1: 'xhigh', S2: 'high', S3: 'low' },
  high: { S0: 'xhigh', S1: 'high', S2: 'mid', S3: 'low' },
  // mid 以下
  low: { S0: 'high', S1: 'mid', S2: 'low', S3: 'xlow' },
}

export const bugPriority = (impact: Priority, severity: Severity): Priority => {
  const row = impact === 'max' || impact === 'xhigh' || impact === 'high' ? impact : 'low'
  return BUG_TABLE[row][severity]
}

export const byId = (a: Task, b: Task): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const createdKey = (t: Task): number => {
  const ms = Date.parse(t.created)
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms
}

/** 一覧の並び：優先度の高い順 → 作成日時の古い順 → id。読み込み順に関係なく同じ順になる。 */
export const byPriority = (a: Task, b: Task): number =>
  ordinal(b.priority) - ordinal(a.priority) || createdKey(a) - createdKey(b) || byId(a, b)

export const sortTasks = (tasks: readonly Task[]): Task[] => [...tasks].sort(byPriority)
