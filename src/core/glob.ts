// scope.paths の glob 照合。パスはプロジェクトルートからの相対で、区切りは "/"。
//   **   任意の深さのディレクトリ（"/" を含む）
//   *    "/" を含まない任意の文字列
//   ?    "/" 以外の1文字
//   {a,b} どれか
// ワイルドカードを含まない指定は、そのファイル自身か、そのディレクトリの配下に一致する。

const cache = new Map<string, RegExp>()

const escape = (c: string): string => (/[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c)

const compile = (pattern: string): RegExp => {
  const hit = cache.get(pattern)
  if (hit) return hit
  let source = ''
  let braces = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const isSegment = (i === 0 || pattern[i - 1] === '/') && (pattern[i + 2] === '/' || i + 2 === pattern.length)
        if (isSegment && pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else if (isSegment && i > 0) {
          // "dir/**" はディレクトリ自身にも一致させる
          source = `${source.slice(0, -1)}(?:/.*)?`
          i += 1
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (c === '?') {
      source += '[^/]'
    } else if (c === '{') {
      braces++
      source += '(?:'
    } else if (c === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (c === ',' && braces > 0) {
      source += '|'
    } else {
      source += escape(c)
    }
  }
  const regex = new RegExp(`^${source}$`)
  cache.set(pattern, regex)
  return regex
}

export const normalizePath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')

const hasWildcard = (pattern: string): boolean => /[*?{]/.test(pattern)

export const matchesPattern = (path: string, pattern: string): boolean => {
  const p = normalizePath(pattern)
  const target = normalizePath(path)
  if (p === '') return false
  if (!hasWildcard(p)) return target === p || target.startsWith(`${p}/`)
  return compile(p).test(target)
}

export const inScope = (path: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern => matchesPattern(path, pattern))

/** 範囲として広すぎる指定（リポジトリ全体に一致するもの）。 */
export const isTooBroad = (pattern: string): boolean => {
  const p = normalizePath(pattern)
  return p === '' || p === '.' || /^(\*\*\/?)+\*?$/.test(p) || p === '*' || p === '**/*'
}

/** 絶対パスをルートからの相対にする。ルートの外なら null。 */
export const relativeTo = (root: string, path: string): string | null => {
  const r = normalizePath(root)
  const p = normalizePath(path)
  if (!p.startsWith('/') && !/^[A-Za-z]:\//.test(p)) return p
  if (p === r) return ''
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null
}
