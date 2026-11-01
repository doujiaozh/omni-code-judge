/**
 * judge_core — source parsing layer.
 *
 * Parses JS / JSX / TS / TSX with the pure-JS @babel/parser (zero native
 * modules, safe on Windows 7). Every analyzer downstream shares one AST walk
 * helper so we never re-traverse the same tree.
 *
 * Also handles unified git diffs: the "+" lines are reassembled into virtual
 * per-file sources so a diff can be graded exactly like a patch review.
 */

import { parse, type ParserPlugin } from '@babel/parser'

export type Language = 'js' | 'ts' | 'jsx' | 'tsx' | 'unknown'

const PLUGINS = [
  'jsx',
  'typescript',
  'decorators-legacy',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'asyncGenerators',
  'functionBind',
  'functionSent',
  'dynamicImport',
  'numericSeparator',
  'optionalChaining',
  'optionalCatchBinding',
  'objectRestSpread',
  'topLevelAwait',
] as const

/**
 * Structural stand-in for @babel/types' `File` node. Defined locally because
 * @babel/parser does not re-export the `File` type itself.
 */
export interface BabelFile {
  type: 'File'
  program: { type: 'Program'; body: unknown[] }
  comments?: Array<{
    type: string
    value: string
    loc?: { start: { line: number }; end: { line: number } }
  }>
}

export interface ParseOutcome {
  language: Language
  /** null when the source cannot be parsed (analyzers then degrade to regex). */
  ast: BabelFile | null
  error?: string
}

/** Detect language from a file path. */
export function detectLanguage(path: string): Language {
  const ext = path.toLowerCase().match(/\.([a-z]+)$/)?.[1] ?? ''
  switch (ext) {
    case 'ts':
      return 'ts'
    case 'tsx':
      return 'tsx'
    case 'jsx':
      return 'jsx'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'js'
    default:
      return 'unknown'
  }
}

/** Parse a source string; never throws. */
export function parseSource(code: string, language: Language): ParseOutcome {
  if (language === 'unknown') {
    // Treat unknown extensions as plain JS so heuristics still run.
    language = 'js'
  }
  try {
    const ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins: PLUGINS as unknown as ParserPlugin[],
    }) as unknown as BabelFile
    return { language, ast }
  } catch (error) {
    return {
      language,
      ast: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface BabelNode {
  type: string
  loc?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
  start?: number
  end?: number
  leadingComments?: Array<{ type: string; value: string; loc?: { start: { line: number } } }>
  [key: string]: unknown
}

/**
 * Shallow but complete AST walker: visits every node object reachable through
 * own enumerable properties. `enter` may return true to skip a subtree.
 */
export function walkAst(node: unknown, enter: (n: BabelNode, parent: BabelNode | null) => void | boolean): void {
  const visited = new Set<unknown>()
  const stack: Array<[unknown, BabelNode | null]> = [[node, null]]
  while (stack.length > 0) {
    const [current, parent] = stack.pop()!
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    const asNode = current as BabelNode
    if (typeof asNode.type === 'string') {
      const skip = enter(asNode, parent)
      if (skip === true) continue
    }
    for (const key of Object.keys(current)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      const child = (current as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object') stack.push([item, asNode])
        }
      } else if (child && typeof child === 'object') {
        stack.push([child, asNode])
      }
    }
  }
}

/** Extract `//` and `/* *​/` comment line numbers (1-based). */
export function collectCommentLines(ast: BabelFile | null, code: string): number[] {
  const lines: number[] = []
  if (ast?.comments) {
    for (const comment of ast.comments) {
      const start = comment.loc?.start.line
      if (typeof start === 'number') {
        const end = comment.loc?.end.line ?? start
        for (let line = start; line <= end; line++) lines.push(line)
      }
    }
  }
  if (lines.length === 0) {
    // Regex fallback (parse failure or comments array missing). Blank string
    // and regex literals first so `//` inside a URL or a regex is not mistaken
    // for a comment — but deliberately do NOT reuse stripStrings() here, since
    // that now blanks comments too.
    const source = code.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*"|`(?:\\.|[^`\\])*`|\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g, (match) => match.replace(/[^\n]/g, ' '))
    const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      const startLine = source.slice(0, match.index).split('\n').length
      const endLine = startLine + match[0].split('\n').length - 1
      for (let line = startLine; line <= endLine; line++) lines.push(line)
    }
  }
  return [...new Set(lines)].sort((a, b) => a - b)
}

/**
 * Replace comments, string AND regex literals with same-length blanks so
 * regex rules only ever see actual code — not prose comments, string
 * content, or rule patterns embedded in the analyzed source itself.
 */
export function stripStrings(code: string): string {
  let result = ''
  let index = 0
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code)) !== null) {
    result += code.slice(index, match.index)
    // Keep newlines so multi-line comments/templates preserve the line grid.
    result += match[0].replace(/[^\n]/g, ' ')
    index = match.index + match[0].length
  }
  result += code.slice(index)
  return result
}

/** Line of a node, 1-based; 0 when unknown. */
export function lineOf(node: BabelNode): number {
  return node.loc?.start.line ?? 0
}

/* ------------------------------------------------------------------ *
 * Git diff support
 * ------------------------------------------------------------------ */

export interface DiffChunk {
  /** Virtual path, e.g. `src/index.ts (added lines)`. */
  path: string
  /** Reassembled from the diff's added lines. */
  code: string
}

const DIFF_FILE_HEADER = /^(?:diff --git|Index:|---|\+\+\+) /

/** True when the text looks like a unified git diff. */
export function isDiffText(text: string): boolean {
  const head = text.split('\n').slice(0, 40).join('\n')
  return /^diff --git /m.test(head) || /^Index: /m.test(head) ||(/^--- /m.test(head) && /^\+\+\+ /m.test(head))
}

/** Extract added lines per file from a unified diff. */
export function parseDiff(text: string): DiffChunk[] {
  const chunks = new Map<string, string[]>()
  const lines = text.split('\n')
  let current: { path: string; lines: string[] } | null = null
  let inHunk = false

  const adopt = (path: string, content: string[]): void => {
    if (!path) return
    const existing = chunks.get(path)
    if (existing) {
      // Merge shared context lines and added lines; context only matters so
      // the reassembled fragment still parses.
      existing.push(...content)
    } else {
      chunks.set(path, content)
    }
  }

  for (const raw of lines) {
    if (DIFF_FILE_HEADER.test(raw)) {
      if (current) adopt(current.path, current.lines)
      inHunk = false
      let path = ''
      if (raw.startsWith('diff --git')) {
        const match = raw.match(/^diff --git a\/(\S+) b\/(\S+)$/)
        path = match?.[2] ?? match?.[1] ?? ''
      } else if (raw.startsWith('+++')) {
        path = raw.slice(4).trim().replace(/^b\//, '')
      } else if (raw.startsWith('---')) {
        path = raw.slice(4).trim().replace(/^a\//, '')
      } else if (raw.startsWith('Index:')) {
        path = raw.slice(7).trim()
      }
      current = path ? { path, lines: [] } : null
      continue
    }
    if (/^@@/.test(raw)) {
      inHunk = true
      continue
    }
    if (!inHunk || !current) continue
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.lines.push(raw.slice(1))
    } else if (raw.startsWith(' ') || raw === '') {
      current.lines.push(raw.startsWith(' ') ? raw.slice(1) : '')
    }
  }
  if (current) adopt(current.path, current.lines)

  return [...chunks.entries()]
    .filter(([path, lines]) => path && lines.some((line) => line.trim().length > 0))
    .map(([path, lines]) => ({
      path: `${path} (diff +lines)`,
      code: lines.join('\n'),
    }))
}
