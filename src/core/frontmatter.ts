// タスクファイル（YAML frontmatter + 本文）の読み書き。
// 実行時依存を持たないため、タスクファイルで使う YAML の部分集合だけを扱う：
// スカラー、フロー配列 [a, b]、ブロック配列 "- a"、入れ子のマップ。
// チェックリストの項目 "- [x] やること" は、引用符がなくても文字列として読む。

import { ID_PATTERN, KINDS, PRIORITIES, SEVERITIES, STATUSES } from './types.ts'
import type { ChecklistItem, Task } from './types.ts'

type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml }
type Line = { indent: number; text: string; no: number }

class YamlError extends Error {}

const splitFlow = (inner: string): string[] => {
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string
    if (quote) {
      current += c
      if (c === '\\' && quote === '"') {
        current += inner[++i] ?? ''
      } else if (c === quote) {
        quote = null
      }
    } else if (c === '"' || c === "'") {
      quote = c
      current += c
    } else if (c === ',') {
      items.push(current)
      current = ''
    } else {
      current += c
    }
  }
  if (current.trim() !== '') items.push(current)
  return items.map(s => s.trim())
}

/** チェックリストの項目の先頭（"[ ] " か "[x] "）。 */
const CHECK_MARK = /^\[( |x|X)\](\s|$)/

const parseScalar = (raw: string, no: number): Yaml => {
  const text = raw.trim()
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as string
    } catch {
      throw new YamlError(`line ${no}: bad double-quoted string`)
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError(`line ${no}: bad single-quoted string`)
    return text.slice(1, -1).replaceAll("''", "'")
  }
  if (CHECK_MARK.test(text)) return text
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new YamlError(`line ${no}: unclosed [`)
    return splitFlow(text.slice(1, -1)).map(item => parseScalar(item, no))
  }
  if (text === '|' || text === '>' || text.startsWith('{')) {
    throw new YamlError(`line ${no}: unsupported YAML syntax (${text.slice(0, 10)})`)
  }
  const plain = text.replace(/\s+#.*$/, '')
  if (plain === '' || plain === '~' || plain === 'null') return null
  if (plain === 'true') return true
  if (plain === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain)
  return plain
}

const isListItem = (line: Line): boolean => line.text === '-' || line.text.startsWith('- ')

const parseBlock = (lines: Line[], start: number, indent: number): [Yaml, number] => {
  const first = lines[start]
  if (first && first.indent === indent && isListItem(first)) {
    const list: Yaml[] = []
    let i = start
    while (i < lines.length) {
      const line = lines[i] as Line
      if (line.indent !== indent || !isListItem(line)) break
      list.push(parseScalar(line.text.slice(1), line.no))
      i++
    }
    return [list, i]
  }
  const map: { [key: string]: Yaml } = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i] as Line
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlError(`line ${line.no}: unexpected indentation`)
    const match = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/.exec(line.text)
    if (!match) throw new YamlError(`line ${line.no}: expected "key: value"`)
    const key = match[1] as string
    const rest = (match[2] ?? '').trim()
    i++
    if (rest !== '' && !rest.startsWith('#')) {
      map[key] = parseScalar(rest, line.no)
      continue
    }
    const next = lines[i]
    if (next && next.indent > indent) {
      const [value, after] = parseBlock(lines, i, next.indent)
      map[key] = value
      i = after
    } else if (next && next.indent === indent && isListItem(next)) {
      // "key:" の直下に同じ字下げで "- item" を並べる書き方
      const [value, after] = parseBlock(lines, i, indent)
      map[key] = value
      i = after
    } else {
      map[key] = null
    }
  }
  return [map, i]
}

export const parseYaml = (text: string): { [key: string]: Yaml } => {
  const lines: Line[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return
    if (/^\t/.test(raw)) throw new YamlError(`line ${index + 1}: tabs are not allowed for indentation`)
    const indent = raw.length - raw.trimStart().length
    lines.push({ indent, text: raw.trim(), no: index + 1 })
  })
  if (lines.length === 0) return {}
  const [value] = parseBlock(lines, 0, (lines[0] as Line).indent)
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    throw new YamlError('frontmatter must be a mapping')
  }
  return value
}

/** ファイルを frontmatter と本文に分ける。 */
export const splitFrontmatter = (text: string): { head: string; body: string } => {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) throw new YamlError('file must start with a --- frontmatter block')
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) throw new YamlError('frontmatter is not closed with ---')
  const head = normalized.slice(4, end + 1)
  const after = normalized.slice(end + 4)
  const body = after.replace(/^[^\n]*\n?/, '').replace(/^\n/, '').replace(/\s+$/, '')
  return { head, body }
}

// ---- 検証と正規化 ----

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined

const asStrings = (v: unknown, field: string): string[] => {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return [v]
  if (!Array.isArray(v)) throw new YamlError(`${field} must be a list`)
  return v.map(item => {
    const s = asString(item)
    if (s === undefined) throw new YamlError(`${field} must be a list of strings`)
    return s
  })
}

const oneOf = <T extends string>(v: unknown, values: readonly T[], field: string, required: boolean): T | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new YamlError(`${field} is required`)
    return undefined
  }
  if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T
  throw new YamlError(`${field} must be one of ${values.join(' / ')} (got ${JSON.stringify(v)})`)
}

const toChecklist = (values: string[]): ChecklistItem[] =>
  values.map(value => {
    const match = /^\[( |x|X)\]\s*(.*)$/.exec(value)
    return match ? { text: (match[2] ?? '').trim(), done: match[1] !== ' ' } : { text: value.trim(), done: false }
  })

/** 以前の形式の状態。後回しは todo として読む。 */
const LEGACY_STATUS: Record<string, Task['status']> = { deferred: 'todo' }

/** frontmatter の値をタスクに直す。形が崩れていれば例外。 */
export const toTask = (data: { [key: string]: unknown }, body: string): Task => {
  const id = asString(data.id)
  if (!id || !ID_PATTERN.test(id)) throw new YamlError(`id must look like T-0001 (got ${JSON.stringify(data.id)})`)
  const title = asString(data.title)
  if (!title) throw new YamlError('title is required')
  const status = typeof data.status === 'string' && LEGACY_STATUS[data.status] ? LEGACY_STATUS[data.status] : data.status
  // 以前の形式の acceptance は、未チェックのチェックリストとして読む
  const checklist = data.checklist !== undefined ? data.checklist : data.acceptance
  const task: Task = {
    schema: typeof data.schema === 'number' ? data.schema : 1,
    id,
    title,
    kind: oneOf(data.kind, KINDS, 'kind', true)!,
    priority: oneOf(data.priority, PRIORITIES, 'priority', true)!,
    status: oneOf(status, STATUSES, 'status', true)!,
    depends_on: asStrings(data.depends_on, 'depends_on'),
    checklist: toChecklist(asStrings(checklist, 'checklist')),
    created: asString(data.created) ?? '',
    updated: asString(data.updated) ?? '',
    body,
  }
  const severity = oneOf(data.severity, SEVERITIES, 'severity', false)
  if (severity) task.severity = severity
  const impacts = asString(data.impacts)
  if (impacts) task.impacts = impacts
  const notes = asString(data.notes)
  if (notes) task.notes = notes
  return task
}

export const parseTask = (text: string): Task => {
  const { head, body } = splitFrontmatter(text)
  return toTask(parseYaml(head), body)
}

// ---- 書き出し ----

const RESERVED = /^(true|false|null|~|yes|no|on|off|-?\d+(\.\d+)?)$/i

const scalar = (value: string): string => {
  const isPlain =
    value !== '' &&
    value === value.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/[\n\r\t]/.test(value) &&
    !value.includes(': ') &&
    !value.includes(' #') &&
    !value.endsWith(':') &&
    !RESERVED.test(value)
  return isPlain ? value : JSON.stringify(value)
}

const flow = (values: string[]): string => `[${values.map(scalar).join(', ')}]`

const block = (key: string, values: string[], indent = ''): string[] =>
  values.length === 0 ? [`${indent}${key}: []`] : [`${indent}${key}:`, ...values.map(v => `${indent}  - ${scalar(v)}`)]

/** タスクをファイルの文字列にする。フィールドの順は常に同じ。 */
export const serializeTask = (task: Task): string => {
  const out: string[] = ['---']
  out.push(`schema: ${task.schema}`)
  out.push(`id: ${task.id}`)
  out.push(`title: ${scalar(task.title)}`)
  out.push(`kind: ${task.kind}`)
  out.push(`priority: ${task.priority}`)
  out.push(`status: ${task.status}`)
  if (task.depends_on.length > 0) out.push(`depends_on: ${flow(task.depends_on)}`)
  out.push(...block('checklist', task.checklist.map(item => `[${item.done ? 'x' : ' '}] ${item.text}`)))
  if (task.severity) out.push(`severity: ${task.severity}`)
  if (task.impacts) out.push(`impacts: ${scalar(task.impacts)}`)
  if (task.notes) out.push(`notes: ${scalar(task.notes)}`)
  out.push(`created: ${scalar(task.created)}`)
  out.push(`updated: ${scalar(task.updated)}`)
  out.push('---')
  const body = task.body.replace(/\s+$/, '')
  return `${out.join('\n')}\n${body === '' ? '' : `\n${body}\n`}`
}
