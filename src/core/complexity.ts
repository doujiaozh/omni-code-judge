/**
 * judge_core — Dimension 1/5: 复杂度 Complexity.
 *
 * Cyclomatic complexity (decision points), loop-nesting depth and per-function
 * size, measured with a single AST pass per file.
 */

import type { AnalyzedFile, Finding, FunctionProfile, MetricEntry } from '../types.js'
import { walkAst, type BabelFile, type BabelNode } from './parser.js'

/** Node types that each add one linearly-independent path through a function. */
const DECISION_TYPES = new Set([
  'IfStatement',
  'ConditionalExpression',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchCase',
  'CatchClause',
  'OptionalCallExpression',
])

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
])
const NEST_TYPES = new Set([...LOOP_TYPES, 'IfStatement', 'SwitchStatement', 'TryStatement'])
export const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ObjectMethod',
  'ClassPrivateMethod',
])

export interface ComplexityResult {
  functions: FunctionProfile[]
  maxCyclomatic: number
  avgCyclomatic: number
  maxNesting: number
  maxLoopNesting: number
  longFunctions: number
  score: number
  metrics: MetricEntry[]
  findings: Finding[]
}

function functionName(node: BabelNode, parent: BabelNode | null): string {
  const n = node as Record<string, unknown>
  if (typeof n.id === 'object' && n.id !== null) {
    const id = n.id as { name?: string }
    if (id.name) return id.name
  }
  if (parent) {
    const p = parent as Record<string, unknown>
    if (parent.type === 'VariableDeclarator' && typeof p.id === 'object' && p.id !== null) {
      const id = p.id as { name?: string }
      if (id.name) return id.name
    }
    if (parent.type === 'Property' && p.computed !== true) {
      const key = p.key as { name?: string; value?: string }
      if (key?.name) return key.name
      if (key?.value) return String(key.value)
    }
    if (parent.type === 'ClassMethod' || parent.type === 'ObjectMethod' || parent.type === 'ClassPrivateMethod') {
      const key = p.key as { name?: string }
      if (key?.name) return key.name
    }
    if (parent.type === 'AssignmentExpression' && p.operator === '=') {
      const left = p.left as { name?: string; property?: { name?: string } }
      if (left?.name) return left.name
      if (left?.property?.name) return left.property.name
    }
  }
  return '<anonymous>'
}

function paramCount(node: BabelNode): number {
  const params = (node as Record<string, unknown>).params
  return Array.isArray(params) ? params.length : 0
}

/**
 * Collect one FunctionProfile per function-like node. Nested functions are
 * measured independently (each gets its own complexity budget) — a nested
 * callback's branches do not inflate its outer function's score.
 */
export function collectFunctionProfiles(ast: BabelFile | null, code: string): FunctionProfile[] {
  if (!ast) return approximateFunctions(code)
  const profiles: FunctionProfile[] = []

  walkAst(ast, (node, parent) => {
    if (!FUNCTION_TYPES.has(node.type)) return false
    const start = node.loc?.start.line ?? 0
    const end = node.loc?.end.line ?? start
    // ClassMethod/ClassPrivateMethod have no loc on their FunctionExpression
    // value; their own loc covers the signature and body, which is what we want.
    const effectiveEnd = end >= start ? end : start
    const counter = measureSubtree(node)
    profiles.push({
      name: functionName(node, parent),
      line: start,
      endLine: effectiveEnd,
      length: Math.max(1, effectiveEnd - start + 1),
      cyclomatic: counter.cyclomatic,
      nesting: counter.maxNesting,
      maxLoopNesting: counter.maxLoopNesting,
      params: paramCount(node),
    })
    // Keep walking: nested arrow callbacks matter too.
    return false
  })

  // Functions with identical start lines (overloads, getters of the same spot)
  // are deduplicated so averages are not skewed.
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    const key = `${profile.line}:${profile.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface FunctionCounter {
  cyclomatic: number
  maxNesting: number
  maxLoopNesting: number
}

/** Measure a function body, ignoring nested function subtrees. */
function measureSubtree(funcNode: BabelNode): FunctionCounter {
  const counter: FunctionCounter = { cyclomatic: 1, maxNesting: 0, maxLoopNesting: 0 }
  const body = (funcNode as Record<string, unknown>).body
  if (!body) return counter

  const recurse = (node: unknown, depth: number, loopDepth: number): void => {
    if (!node || typeof node !== 'object') return
    const n = node as BabelNode
    if (typeof n.type === 'string' && node !== body && FUNCTION_TYPES.has(n.type)) {
      // Nested function owns its own budget — do not descend.
      return
    }
    if (typeof n.type === 'string' && DECISION_TYPES.has(n.type)) counter.cyclomatic += 1
    let nextDepth = depth
    let nextLoop = loopDepth
    if (typeof n.type === 'string' && NEST_TYPES.has(n.type)) {
      nextDepth = depth + 1
      if (counter.maxNesting < nextDepth) counter.maxNesting = nextDepth
      if (LOOP_TYPES.has(n.type)) {
        nextLoop = loopDepth + 1
        if (counter.maxLoopNesting < nextLoop) counter.maxLoopNesting = nextLoop
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      const child = (node as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const item of child) recurse(item, nextDepth, nextLoop)
      } else if (child && typeof child === 'object') {
        recurse(child, nextDepth, nextLoop)
      }
    }
  }
  recurse(body, 0, 0)
  return counter
}

/** Coarse regex fallback when the AST is unavailable (exotic syntax). */
function approximateFunctions(code: string): FunctionProfile[] {
  const lines = code.split('\n')
  const profiles: FunctionProfile[] = []
  const pattern =
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code)) !== null) {
    const name = match[1] ?? match[2] ?? '<anonymous>'
    const startLine = code.slice(0, match.index).split('\n').length
    let depth = 0
    let started = false
    let endLine = startLine
    for (let line = startLine - 1; line < lines.length; line++) {
      for (const char of lines[line]) {
        if (char === '{') {
          depth++
          started = true
        } else if (char === '}') depth--
      }
      if (started && depth <= 0) {
        endLine = line + 1
        break
      }
    }
    const body = lines.slice(startLine - 1, endLine).join('\n')
    const loopCount = body.match(/\bfor\s*\(|while\s*\(/g)?.length ?? 0
    profiles.push({
      name,
      line: startLine,
      endLine,
      length: Math.max(1, endLine - startLine + 1),
      cyclomatic: 1 + (body.match(/\b(if|else|for|while|case|catch|&&|\|\?)\b/g)?.length ?? 0),
      nesting: Math.min(4, loopCount + (body.match(/\bif\s*\(/g)?.length ?? 0)),
      maxLoopNesting: loopCount > 0 ? 1 : 0,
      params: (lines[startLine - 1].match(/,/g)?.length ?? 0) + (lines[startLine - 1].includes('(') ? 1 : 0),
    })
  }
  return profiles
}

/** Score the complexity dimension across every collected profile. */
export function analyzeComplexity(files: AnalyzedFile[], longFunctionThreshold = 50): ComplexityResult {
  const functions: FunctionProfile[] = []
  const findings: Finding[] = []

  for (const file of files) {
    for (const fn of file.functions) {
      functions.push(fn)
      if (fn.length > longFunctionThreshold) {
        findings.push({
          dimension: 'complexity',
          severity: fn.length > 120 ? 'major' : 'minor',
          rule: 'CPL-002',
          message: `Function "${fn.name}" spans ${fn.length} lines (threshold ${longFunctionThreshold}) — 函数过长，按职责拆分`,
          line: fn.line,
          file: file.path,
        })
      }
      if (fn.cyclomatic >= 10) {
        findings.push({
          dimension: 'complexity',
          severity: fn.cyclomatic >= 20 ? 'major' : 'minor',
          rule: 'CPL-001',
          message: `Function "${fn.name}" has cyclomatic complexity ${fn.cyclomatic} — 分支过多，决策点爆炸`,
          line: fn.line,
          file: file.path,
        })
      }
      if (fn.nesting >= 5 || fn.maxLoopNesting >= 3) {
        findings.push({
          dimension: 'complexity',
          severity: fn.maxLoopNesting >= 4 || fn.nesting >= 7 ? 'major' : 'minor',
          rule: 'CPL-003',
          message: `Function "${fn.name}" nests ${fn.nesting} levels (loop depth ${fn.maxLoopNesting}) — 循环/分支嵌套过深`,
          line: fn.line,
          file: file.path,
        })
      }
      if (fn.params >= 6) {
        findings.push({
          dimension: 'complexity',
          severity: fn.params >= 8 ? 'major' : 'minor',
          rule: 'CPL-004',
          message: `Function "${fn.name}" takes ${fn.params} parameters — 参数过多，引入参数对象`,
          line: fn.line,
          file: file.path,
        })
      }
    }
  }

  const total = functions.length
  const maxCyclomatic = functions.reduce((max, fn) => Math.max(max, fn.cyclomatic), 0)
  const avgCyclomatic = total > 0 ? functions.reduce((sum, fn) => sum + fn.cyclomatic, 0) / total : 0
  const maxNesting = functions.reduce((max, fn) => Math.max(max, fn.nesting), 0)
  const maxLoopNesting = functions.reduce((max, fn) => Math.max(max, fn.maxLoopNesting), 0)
  const longFunctions = functions.filter((fn) => fn.length > longFunctionThreshold).length

  // Penalties are scaled so small clean modules land 90+, while a single
  // 300-line cyclomatic-35 monster drags this dimension into the red.
  const longRatio = total > 0 ? longFunctions / total : 0
  const highCcRatio = total > 0 ? functions.filter((fn) => fn.cyclomatic >= 10).length / total : 0
  let score = 100
  score -= Math.min(35, Math.max(0, maxCyclomatic - 15) * 1.5)
  score -= Math.min(20, Math.max(0, avgCyclomatic - 5) * 3)
  score -= Math.min(15, Math.max(0, maxNesting - 3) * 4)
  score -= Math.min(10, Math.max(0, maxLoopNesting - 2) * 5)
  score -= Math.min(20, longRatio * 60)
  score -= Math.min(25, highCcRatio * 80)
  if (total === 0) score = 88 // nothing to judge: assume declarative/simple

  const metrics: MetricEntry[] = [
    { key: 'functions 函数数', value: total },
    { key: 'avg cyclomatic 平均圈复杂度', value: avgCyclomatic.toFixed(2) },
    { key: 'max cyclomatic 最大圈复杂度', value: maxCyclomatic },
    { key: 'max nesting 最大嵌套层数', value: maxNesting },
    { key: 'max loop nesting 最大循环嵌套', value: maxLoopNesting },
    { key: `long functions > ${longFunctionThreshold} lines`, value: longFunctions },
  ]

  return {
    functions,
    maxCyclomatic,
    avgCyclomatic,
    maxNesting,
    maxLoopNesting,
    longFunctions,
    score: Math.max(0, Math.min(100, Math.round(score))),
    metrics,
    findings,
  }
}
