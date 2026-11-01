/**
 * judge_core — orchestration layer.
 *
 * Turns raw targets (file paths, directories or a git diff blob) into a fully
 * scored five-dimension verdict. Pure static analysis — no LLM involved —
 * so `judge.ts` can run fully offline.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  AnalyzedFile,
  DetectedPattern,
  DimensionScore,
  Finding,
  JudgeOptions,
  StaticMetrics,
} from '../types.js'
import {
  collectCommentLines,
  detectLanguage,
  isDiffText,
  parseDiff,
  parseSource,
} from './parser.js'
import { analyzeComplexity, collectFunctionProfiles } from './complexity.js'
import { analyzeSecurity } from './security.js'
import { analyzeMaintainability } from './maintainability.js'
import { analyzeCoverage } from './coverage.js'
import { analyzeDesign } from './design.js'

export interface StaticAnalysis {
  files: AnalyzedFile[]
  metrics: StaticMetrics
  dimensions: Record<DimensionKey, DimensionScore>
  findings: Finding[]
  patterns: DetectedPattern[]
  total: number
}

export type DimensionKey = 'complexity' | 'security' | 'maintainability' | 'testCoverage' | 'designPatterns'

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'coverage'])
const MAX_FILES_PER_DIRECTORY = 200

function isSupportedSource(path: string): boolean {
  const lower = path.toLowerCase()
  return SUPPORTED_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))
}

/** Normalize a filesystem path for stable reporting (forward slashes). */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function loadFile(absolute: string, reportPath: string): AnalyzedFile {
  let content: string
  try {
    content = readFileSync(absolute, 'utf8')
  } catch {
    return {
      path: reportPath,
      language: 'unknown',
      code: '',
      ast: null,
      parseError: 'unreadable file',
      functions: [],
      findings: [],
      patterns: [],
    }
  }
  const language = detectLanguage(absolute)
  const { ast, error } = parseSource(content, language)
  return {
    path: reportPath,
    language,
    code: content,
    ast,
    parseError: error,
    commentLines: collectCommentLines(ast, content),
    functions: collectFunctionProfiles(ast, content),
    findings: [],
    patterns: [],
  }
}

/** Read a directory recursively (bounded) for supported sources. */
function readDirectory(dir: string, cwd: string): AnalyzedFile[] {
  const collected: string[] = []
  const stack = [dir]
  while (stack.length > 0 && collected.length < MAX_FILES_PER_DIRECTORY) {
    const current = stack.pop()!
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      const full = resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (isSupportedSource(full)) {
        collected.push(full)
        if (collected.length >= MAX_FILES_PER_DIRECTORY) break
      }
    }
  }
  return collected.sort().map((absolute) => loadFile(absolute, normalizePath(relative(cwd, absolute) || absolute)))
}

function filesFromDiff(diffText: string): AnalyzedFile[] {
  const chunks = parseDiff(diffText)
  const files: AnalyzedFile[] = []
  for (const chunk of chunks) {
    const language = detectLanguage(chunk.path)
    const { ast } = parseSource(chunk.code, language)
    files.push({
      path: chunk.path,
      language,
      code: chunk.code,
      ast,
      commentLines: collectCommentLines(ast, chunk.code),
      functions: collectFunctionProfiles(ast, chunk.code),
      findings: [],
      patterns: [],
    })
  }
  return files
}

function inlineSource(code: string): AnalyzedFile[] {
  const language = detectLanguage(code) === 'unknown' ? 'ts' : detectLanguage(code)
  const { ast } = parseSource(code, language)
  return [
    {
      path: '<inline>',
      language,
      code,
      ast,
      commentLines: collectCommentLines(ast, code),
      functions: collectFunctionProfiles(ast, code),
      findings: [],
      patterns: [],
    },
  ]
}

function aggregateMetrics(files: AnalyzedFile[]): StaticMetrics {
  let loc = 0
  let sloc = 0
  let commentLines = 0
  let classes = 0
  let imports = 0
  let exportedSymbols = 0

  for (const file of files) {
    loc += file.code ? file.code.split('\n').length : 0
    const comments = file.commentLines ?? []
    commentLines += comments.length
    sloc += Math.max(0, file.code.split('\n').filter((line) => line.trim().length > 0).length - comments.length)
    if (!file.ast) continue
    for (const node of iterTopLevel(file)) {
      switch (node.type) {
        case 'ClassDeclaration':
        case 'ClassExpression':
          classes++
          break
        case 'ImportDeclaration':
        case 'ImportExpression':
          imports++
          break
        case 'ExportNamedDeclaration':
        case 'ExportDefaultDeclaration':
          exportedSymbols++
          break
      }
    }
  }

  const allFunctions = files.flatMap((file) => file.functions)
  const testFiles = files.filter((file) => /\.test\.|\.spec\.|__tests__/.test(file.path)).length
  const commentRatio = sloc > 0 ? commentLines / sloc : 0
  const avgCyclomatic = allFunctions.length > 0 ? allFunctions.reduce((sum, fn) => sum + fn.cyclomatic, 0) / allFunctions.length : 0

  return {
    files: files.length,
    loc,
    sloc,
    commentLines,
    commentRatio,
    functions: allFunctions.length,
    classes,
    imports,
    exportedSymbols,
    maxCyclomatic: allFunctions.reduce((max, fn) => Math.max(max, fn.cyclomatic), 0),
    avgCyclomatic,
    maxNesting: allFunctions.reduce((max, fn) => Math.max(max, fn.nesting), 0),
    longFunctions: allFunctions.filter((fn) => fn.length > 50).length,
    testFiles,
    detectedPatterns: [],
  }
}

function* iterTopLevel(file: AnalyzedFile): Generator<{ type: string }, void, unknown> {
  const program = (file.ast as unknown as { program?: { body?: unknown[] } } | null)?.program
  if (!program?.body) return
  for (const node of program.body) {
    if (node && typeof node === 'object') yield node as { type: string }
  }
}

/**
 * Run the full static pipeline over a judge target.
 *
 * @param target absolute path (file or directory) or inline source/diff text
 * @param options judge options (cwd, diff flag, context)
 */
export function runStaticAnalysis(target: string, options: JudgeOptions): StaticAnalysis {
  const cwd = options.cwd ?? process.cwd()
  let files: AnalyzedFile[]

  if (options.diff || isDiffText(target)) {
    files = filesFromDiff(target)
  } else {
    const absolute = isAbsolute(target) ? target : resolve(cwd, target)
    let stats: ReturnType<typeof statSync> | null = null
    try {
      stats = statSync(absolute)
    } catch {
      stats = null
    }
    if (stats?.isDirectory()) {
      files = readDirectory(absolute, cwd)
    } else if (stats) {
      files = [loadFile(absolute, normalizePath(relative(cwd, absolute) || absolute))]
    } else {
      // Not a path on disk: treat the target itself as inline source code.
      files = inlineSource(target)
    }
  }

  const metrics = aggregateMetrics(files)

  const complexity = analyzeComplexity(files)
  const security = analyzeSecurity(files)
  const maintainability = analyzeMaintainability(files)
  const coverage = analyzeCoverage(files, cwd, { sloc: metrics.sloc })
  const design = analyzeDesign(files)

  for (const file of files) {
    file.patterns = design.patterns.filter((pattern) => pattern.file === file.path)
  }
  metrics.detectedPatterns = design.patterns

  const dimensions: Record<DimensionKey, DimensionScore> = {
    complexity: { dimension: 'complexity', score: complexity.score, weight: 0.25, metrics: complexity.metrics, findings: complexity.findings },
    security: { dimension: 'security', score: security.score, weight: 0.3, metrics: security.metrics, findings: security.findings },
    maintainability: { dimension: 'maintainability', score: maintainability.score, weight: 0.2, metrics: maintainability.metrics, findings: maintainability.findings },
    testCoverage: { dimension: 'testCoverage', score: coverage.score, weight: 0.15, metrics: coverage.metrics, findings: coverage.findings },
    designPatterns: { dimension: 'designPatterns', score: design.score, weight: 0.1, metrics: design.metrics, findings: design.findings },
  }

  const findings = [...complexity.findings, ...security.findings, ...maintainability.findings, ...coverage.findings, ...design.findings]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.line ?? 0) - (b.line ?? 0))

  const total = Math.round(
    Object.values(dimensions).reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0),
  )

  return {
    files,
    metrics,
    dimensions,
    findings,
    patterns: design.patterns,
    total,
  }
}

function severityRank(severity: Finding['severity']): number {
  switch (severity) {
    case 'critical':
      return 0
    case 'major':
      return 1
    case 'minor':
      return 2
    default:
      return 3
  }
}

const GRADE_VERDICTS: ReadonlyArray<[number, string]> = [
  [95, '可载入教科书级代码 — production-grade exemplar 值得整个团队学习'],
  [85, '资深架构师点头通过 — architect-approved 架构成熟，可直接进入代码评审快车道'],
  [70, '生产可发布但需打磨 — shippable with polish 存在体面的技术债'],
  [60, '勉强能跑，技术债明显 — runs, but debt compounds 明显需要重构'],
  [40, '高危代码，必须重构 — high-risk, refactor mandatory 存在系统性问题'],
  [0, '立即下线 — take it offline 红线问题集中爆发'],
]

export function buildStaticVerdict(total: number, findings: Finding[]): string {
  const criticals = findings.filter((finding) => finding.severity === 'critical')
  let verdict = GRADE_VERDICTS.find(([threshold]) => total >= threshold)?.[1] ?? GRADE_VERDICTS[GRADE_VERDICTS.length - 1][1]
  if (criticals.length > 0) {
    verdict += ` · 🔴 ${criticals.length} 张红牌（critical 红线）`
  }
  return verdict
}
