import type { BabelFile } from './core/parser.js'

/**
 * Omni-Code-Judge — shared type contracts.
 *
 * The five dimensions the judge grades on, plus the score / finding / verdict
 * model shared by judge_core (static AST analysis), judge_ai (LLM architect)
 * and judge_report (markdown / HTML battle report).
 */

/** The five grading dimensions, in canonical order. */
export const FIVE_DIMENSIONS = [
  'complexity',
  'security',
  'maintainability',
  'testCoverage',
  'designPatterns',
] as const

export type Dimension = (typeof FIVE_DIMENSIONS)[number]

/** Chat message in the OpenAI-compatible shape spoken by the aether gateway. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
}

/** Weighted contribution to the final 0-100 total. */
export const DIMENSION_WEIGHTS: Record<Dimension, number> = {
  complexity: 0.25,
  security: 0.3,
  maintainability: 0.2,
  testCoverage: 0.15,
  designPatterns: 0.1,
}

/** Bilingual labels for reports (中文 / English). */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  complexity: '复杂度 Complexity',
  security: '安全性 Security',
  maintainability: '可维护性 Maintainability',
  testCoverage: '测试覆盖 Test Coverage',
  designPatterns: '设计模式 Design Patterns',
}

/** The grade scale: from battle-hardened S to "rewrite it" F. */
export const GRADE_THRESHOLDS: ReadonlyArray<[string, number]> = [
  ['S', 95],
  ['A', 85],
  ['B', 70],
  ['C', 60],
  ['D', 40],
]

export type Severity = 'critical' | 'major' | 'minor' | 'info'

export const SEVERITY_META: Record<Severity, { emoji: string; card: string; penalty: number }> = {
  critical: { emoji: '🔴', card: 'RED CARD 红牌', penalty: 40 },
  major: { emoji: '🟠', card: 'YELLOW CARD 黄牌', penalty: 20 },
  minor: { emoji: '🟡', card: 'minor', penalty: 8 },
  info: { emoji: '🔵', card: 'info', penalty: 2 },
}

/**
 * One concrete issue (or positive observation) found in the code.
 * Findings are the evidence behind every score point.
 */
export interface Finding {
  dimension: Dimension
  severity: Severity
  /** Rule id, e.g. SEC-001 for hardcoded credentials. */
  rule: string
  message: string
  line?: number
  file?: string
  snippet?: string
}

/** A named numeric metric shown in the report detail tables. */
export interface MetricEntry {
  key: string
  value: string | number
}

/** Per-dimension verdict. */
export interface DimensionScore {
  dimension: Dimension
  /** Final blended 0-100 score. */
  score: number
  weight: number
  metrics: MetricEntry[]
  findings: Finding[]
  /** Score from the LLM architect, when judge_ai ran. */
  aiScore?: number
  /** Architect comment for this dimension, when judge_ai ran. */
  aiComment?: string
}

/** Function-level profile produced by the complexity analyzer. */
export interface FunctionProfile {
  name: string
  line: number
  endLine: number
  /** Line span of the function body. */
  length: number
  /** Cyclomatic complexity (decision points + 1). */
  cyclomatic: number
  /** Max nesting of loops + branches + switch + try. */
  nesting: number
  /** Max nesting of loops only (循环嵌套层数). */
  maxLoopNesting: number
  params: number
}

/** A design pattern (or design anti-pattern) detected statically. */
export interface DetectedPattern {
  name: string
  kind: 'creational' | 'structural' | 'behavioral' | 'di' | 'anti'
  /** 0-1 static confidence. */
  confidence: number
  evidence: string
  file: string
  line?: number
}

export interface StaticMetrics {
  files: number
  loc: number
  sloc: number
  commentLines: number
  commentRatio: number
  functions: number
  classes: number
  imports: number
  exportedSymbols: number
  maxCyclomatic: number
  avgCyclomatic: number
  maxNesting: number
  longFunctions: number
  testFiles: number
  /** Design patterns detected by the static analyzer. */
  detectedPatterns: DetectedPattern[]
}

/** One analyzed source file (or one virtual file extracted from a diff). */
export interface AnalyzedFile {
  path: string
  language: 'js' | 'ts' | 'jsx' | 'tsx' | 'unknown'
  code: string
  /** Parsed AST (in-process only; never serialized into a report). */
  ast?: BabelFile | null
  parseError?: string
  /** 1-based comment line numbers, computed once during loading. */
  commentLines?: number[]
  functions: FunctionProfile[]
  findings: Finding[]
  patterns: DetectedPattern[]
}

/* ------------------------------------------------------------------ *
 * judge_ai — the LLM senior architect
 * ------------------------------------------------------------------ */

export interface AIScoreEntry {
  score: number
  comment: string
}

export interface AIIdentifiedPattern {
  name: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string
}

export interface BusinessRisk {
  severity: Severity
  title: string
  detail: string
}

export interface AIReview {
  /** Model that answered, or 'local-heuristic' when degraded. */
  model: string
  /** 'live' = real LLM call, 'fallback' = local heuristic architect. */
  mode: 'live' | 'fallback'
  reason?: string
  scores: Partial<Record<Dimension, AIScoreEntry>>
  patterns: AIIdentifiedPattern[]
  risks: BusinessRisk[]
  verdict: string
  rank?: string
  durationMs: number
}

/* ------------------------------------------------------------------ *
 * Final verdict
 * ------------------------------------------------------------------ */

export interface JudgeOptions {
  /** Enable the LLM architect (requires aether gateway credentials). */
  ai?: boolean
  /** Pin a model id on the aether gateway. */
  model?: string
  /** Treat stdin / the given file as a unified git diff. */
  diff?: boolean
  /** Extra context the architect should know (e.g. business domain). */
  context?: string
  /** Working directory for sibling test-file discovery. */
  cwd?: string
}

export interface JudgeResult {
  target: string
  createdAt: string
  files: AnalyzedFile[]
  metrics: StaticMetrics
  patterns: DetectedPattern[]
  dimensions: DimensionScore[]
  findings: Finding[]
  ai?: AIReview
  total: number
  grade: string
  redCards: number
  yellowCards: number
  /** Executive summary text (AI verdict or generated locally). */
  verdictText: string
  /** Wall-clock duration of the whole judging run. */
  durationMs: number
}

/** Clamp a number into [0, 100] and round. */
export function clamp100(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Letter grade from a 0-100 total. */
export function gradeOf(total: number): string {
  for (const [grade, threshold] of GRADE_THRESHOLDS) {
    if (total >= threshold) return grade
  }
  return 'F'
}
