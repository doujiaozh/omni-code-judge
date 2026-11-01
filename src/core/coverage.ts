/**
 * judge_core — Dimension 4/5: 测试覆盖 Test Coverage.
 *
 * Static coverage proxy (no instrumentation, no native modules):
 *  · sibling test discovery — src/foo.ts ⇒ foo.test.ts / __tests__/foo.test.ts …
 *  · assertion density — describe/it/test/expect per 100 sloc across the target
 *  · unit purity — functions without outbound side effects are natively testable
 *  · exported surface — exported symbols are the reachable, contract-worthy part
 */

import { existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { AnalyzedFile, Finding, MetricEntry } from '../types.js'
import { walkAst, type BabelNode } from './parser.js'
import { FUNCTION_TYPES } from './complexity.js'

export interface CoverageResult {
  score: number
  findings: Finding[]
  metrics: MetricEntry[]
}

const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.test.js', '.test.jsx', '.spec.ts', '.spec.tsx', '.spec.js', '.spec.jsx']

const TEST_DIR_NAMES = ['__tests__', 'test', 'tests', '__test__']

/** Heuristic: path already looks like a test file. */
export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[a-z]+$/.test(path) || TEST_DIR_NAMES.some((dir) => path.includes(`${dir}/`) || path.includes(`${dir}\\`))
}

/** Candidate sibling test locations for a source file. */
function siblingTestCandidates(path: string, language: 'js' | 'ts' | 'jsx' | 'tsx' | 'unknown'): string[] {
  const ext = extname(path) || (language === 'ts' ? '.ts' : '.js')
  const base = path.slice(0, path.length - ext.length)
  const dir = dirname(path)
  const candidates: string[] = []

  for (const suffix of TEST_SUFFIXES) candidates.push(base + suffix)
  for (const testDir of TEST_DIR_NAMES) {
    for (const suffix of TEST_SUFFIXES) {
      candidates.push(join(dir, testDir, base.slice(dir.length > 0 ? dir.length + 1 : 0) + suffix))
    }
  }
  // Co-located repeatdirname/index.ts ⇒ test/index.test.ts
  for (const suffix of TEST_SUFFIXES) candidates.push(join(dirname(base), suffix))
  return [...new Set(candidates)]
}

function hasSiblingTest(path: string, language: 'js' | 'ts' | 'jsx' | 'tsx' | 'unknown', cwd: string, knownTestFiles: Set<string>): boolean {
  if (isAbsolute(path)) {
    return siblingTestCandidates(path, language).some((candidate) => knownTestFiles.has(candidate) || existsSync(candidate))
  }
  const rooted = resolve(cwd, path)
  const direct = siblingTestCandidates(rooted, language).some((candidate) => knownTestFiles.has(candidate) || existsSync(candidate))
  if (direct) return true
  // Also honor the on-disk tree relative to the file's own directory.
  const fileDir = dirname(rooted)
  const fileName = path.split(/[/\\]/).pop() ?? path
  return TEST_DIR_NAMES.some((dir) => existsSync(join(fileDir, dir, fileName.replace(/\.[a-z]+$/, '.test' + extname(fileName)))))
}

/** Callees that make a function impure (reachable from outside the unit). */
const SIDE_EFFECT_CALLEE = /^(?:write|writeln|unlink|mkdir|rmdir|rename|copy|remove|exec|execSync|spawn|spawnSync|fetch|request|axios|send|emit|dispatch|publish|notify|redirect|render|mount|unmount|connect|close|destroy|save|delete|removeItem|setItem|alert|prompt|confirm|commit|rollback|insert|update|query|transaction|dispatchEvent|addEventListener|postMessage|log|warn|error|info|debug|trace)\b/

interface PuritySnapshot {
  pureFunctions: number
  totalFunctions: number
  exportedFunctions: number
  sideEffectFunctions: number
}

function scanPurity(file: AnalyzedFile): PuritySnapshot {
  const snapshot: PuritySnapshot = { pureFunctions: 0, totalFunctions: 0, exportedFunctions: 0, sideEffectFunctions: 0 }
  if (!file.ast) {
    snapshot.totalFunctions = file.functions.length
    return snapshot
  }

  walkAst(file.ast, (node, parent) => {
    if (!FUNCTION_TYPES.has(node.type)) return false
    snapshot.totalFunctions++

    const exported = parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration'
    if (exported) snapshot.exportedFunctions++

    let hasReturn = false
    let sideEffect = false
    walkAst(node, (inner) => {
      if (inner !== node && FUNCTION_TYPES.has(inner.type) && inner.type !== 'ClassMethod') return true
      if (inner.type === 'ReturnStatement' && (inner as Record<string, unknown>).argument != null) hasReturn = true
      if (inner.type === 'CallExpression' || inner.type === 'OptionalCallExpression' || inner.type === 'NewExpression') {
        const callee = (inner as Record<string, unknown>).callee as BabelNode | undefined
        const name = calleeProperty(callee)
        if (name && SIDE_EFFECT_CALLEE.test(name)) sideEffect = true
      }
      if (inner.type === 'AwaitExpression') sideEffect = true
      if (inner.type === 'YieldExpression') sideEffect = true
      return false
    })

    if (sideEffect) snapshot.sideEffectFunctions++
    else if (hasReturn || node.type === 'ArrowFunctionExpression') snapshot.pureFunctions++
    return false
  })
  return snapshot
}

function calleeProperty(callee: BabelNode | undefined): string {
  if (!callee) return ''
  if (callee.type === 'Identifier') {
    const name = (callee as Record<string, unknown>).name
    return typeof name === 'string' ? name : ''
  }
  if (callee.type === 'MemberExpression') {
    const property = (callee as Record<string, unknown>).property as BabelNode | undefined
    if (property?.type === 'Identifier') {
      const name = (property as Record<string, unknown>).name
      return typeof name === 'string' ? name : ''
    }
    if (property?.type === 'StringLiteral') {
      const value = (property as Record<string, unknown>).value
      return typeof value === 'string' ? value : ''
    }
  }
  return ''
}

export function analyzeCoverage(files: AnalyzedFile[], cwd: string, metrics0?: { sloc: number }): CoverageResult {
  const findings: Finding[] = []
  const metrics: MetricEntry[] = []

  const sourceFiles = files.filter((file) => !isTestPath(file.path))
  const testFiles = files.filter((file) => isTestPath(file.path))
  const allFunctions = files.reduce((sum, file) => sum + file.functions.length, 0)

  // Assertions anywhere in the input (in case the judge target is a test file itself).
  let assertions = 0
  for (const file of files) {
    const pattern = /\b(describe|it|test|expect|assert|should)\s*\(/g
    assertions += file.code.match(pattern)?.length ?? 0
    if (!file.ast) continue
    walkAst(file.ast, (node) => {
      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        const name = calleeProperty((node as Record<string, unknown>).callee as BabelNode)
        if (/^(describe|it|test|expect|assert)$/.test(name)) assertions++
      }
      return false
    })
  }

  // Sibling coverage
  const knownTestFiles = new Set(testFiles.map((file) => file.path))
  let covered = 0
  for (const file of sourceFiles) {
    if (hasSiblingTest(file.path, file.language, cwd, knownTestFiles)) {
      covered++
    } else {
      findings.push({
        dimension: 'testCoverage',
        severity: 'minor',
        rule: 'TST-001',
        message: `No sibling test file found for ${file.path} — 未发现同级测试文件，裸奔代码`,
        file: file.path,
      })
    }
  }

  // Purity + exports
  let pureFunctions = 0
  let exportedFunctions = 0
  for (const file of files) {
    const snapshot = scanPurity(file)
    pureFunctions += snapshot.pureFunctions
    exportedFunctions += snapshot.exportedFunctions
  }

  const siblingRatio = sourceFiles.length > 0 ? covered / sourceFiles.length : testFiles.length > 0 ? 1 : 0
  const sloc = metrics0?.sloc ?? Math.max(1, files.reduce((sum, file) => sum + file.code.split('\n').filter((line) => line.trim()).length, 0))
  const assertionDensity = (assertions / Math.max(1, sloc / 100)) // per 100 sloc
  const pureRatio = allFunctions > 0 ? pureFunctions / allFunctions : 0.5
  const exportRatio = allFunctions > 0 ? exportedFunctions / allFunctions : 0.5

  // Weighted blend: sibling coverage dominates because it is the direct signal.
  let score = 0
  score += 50 * siblingRatio
  score += 15 * Math.min(1, assertionDensity / 3)
  score += 20 * pureRatio
  score += 15 * exportRatio

  if (sourceFiles.length === 0 && testFiles.length > 0) score = Math.max(85, score) // the target IS tests
  if (allFunctions === 0) score = 82 // declarative/config target: untestable-by-design

  metrics.push({ key: 'source files 源文件', value: sourceFiles.length })
  metrics.push({ key: 'test files 测试文件', value: testFiles.length })
  metrics.push({ key: 'sibling coverage 同级覆盖', value: `${(siblingRatio * 100).toFixed(0)}% (${covered}/${sourceFiles.length || testFiles.length})` })
  metrics.push({ key: 'assertions 断言数', value: assertions })
  metrics.push({ key: 'assertions / 100 sloc', value: assertionDensity.toFixed(2) })
  metrics.push({ key: 'pure functions 纯函数', value: `${(pureRatio * 100).toFixed(0)}% (${pureFunctions}/${allFunctions})` })
  metrics.push({ key: 'export ratio 导出率', value: `${(exportRatio * 100).toFixed(0)}%` })

  if (siblingRatio < 0.5 && sourceFiles.length > 0) {
    findings.push({
      dimension: 'testCoverage',
      severity: 'major',
      rule: 'TST-002',
      message: `Only ${(siblingRatio * 100).toFixed(0)}% of source files have sibling tests — 测试覆盖不足半数源文件`,
    })
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    findings,
    metrics,
  }
}
