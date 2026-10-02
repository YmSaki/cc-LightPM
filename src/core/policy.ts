// フェーズポリシーとバグ優先度の表。

import { KINDS, PHASES, PRIORITIES, ordinal } from './types.ts'
import type {
  DeferReason,
  DeferUntil,
  Kind,
  Phase,
  Policy,
  PolicyOverride,
  Priority,
  Rule,
  Severity,
  Task,
} from './types.ts'

/** 仕様書「着手できる下限（実効優先度）」の既定値。 */
export const DEFAULT_POLICY: Policy = {
  alpha: {
    feature: { min: 'high' },
    bug: { min: 'xhigh' },
    chore: { min: 'mid' },
    refactor: { min: 'xhigh' },
    polish: { min: 'xhigh' },
    release: { min: null },
  },
  beta: {
    feature: { min: 'xhigh' },
    bug: { min: 'mid' },
    chore: { min: 'mid' },
    refactor: { min: 'high' },
    polish: { min: 'high' },
    release: { min: null },
  },
  rc: {
    feature: { min: null },
    bug: { min: 'high', blocker: true },
    chore: { min: 'high' },
    refactor: { min: null },
    polish: { min: null },
    release: { min: null },
  },
  gm: {
    feature: { min: null },
    bug: { min: null, blocker: true },
    chore: { min: null },
    refactor: { min: null },
    polish: { min: null },
    release: { min: 'xlow' },
  },
}

/** フェーズの主役の種別（並べ替えの3番目のキー）。 */
export const MAIN_KIND: Record<Phase, Kind> = {
  alpha: 'feature',
  beta: 'bug',
  rc: 'bug',
  gm: 'release',
}

const toRule = (value: Priority | null | Rule | undefined, base: Rule): Rule => {
  if (value === undefined) return base
  if (value === null) return { min: null }
  if (typeof value === 'string') {
    return (PRIORITIES as readonly string[]).includes(value) ? { min: value } : base
  }
  return { min: value.min ?? null, blocker: value.blocker === true }
}

/** config.json の policy を既定値に重ねる。知らないキーは無視する。 */
export const resolvePolicy = (override: PolicyOverride | undefined): Policy => {
  const policy = structuredClone(DEFAULT_POLICY)
  if (!override || typeof override !== 'object') return policy
  for (const phase of PHASES) {
    const byKind = override[phase]
    if (!byKind || typeof byKind !== 'object') continue
    for (const kind of KINDS) {
      policy[phase][kind] = toRule(byKind[kind], policy[phase][kind])
    }
  }
  return policy
}

export type Admission = { ok: true } | { ok: false; reason: DeferReason }

/** タスクがそのフェーズで着手できるか。eff は実効優先度の序数。 */
export const admits = (policy: Policy, phase: Phase, task: Task, eff: number): Admission => {
  const rule = policy[phase][task.kind]
  if (rule.blocker && task.release_blocker === true) return { ok: true }
  if (rule.min === null) return { ok: false, reason: rule.blocker ? 'P-FLOOR' : 'P-KIND' }
  return eff >= ordinal(rule.min) ? { ok: true } : { ok: false, reason: 'P-FLOOR' }
}

/** 今のフェーズより後で、最初に着手できるフェーズ。どこでも無理なら post。 */
export const deferUntil = (policy: Policy, phase: Phase, task: Task, eff: number): DeferUntil => {
  for (const later of PHASES.slice(PHASES.indexOf(phase) + 1)) {
    if (admits(policy, later, task, eff).ok) return later
  }
  return 'post'
}

/** 仕様書「バグの優先度」の表。行は影響先の優先度、列は重大度。 */
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
