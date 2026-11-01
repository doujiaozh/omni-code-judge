/**
 * judge_core — Dimension 3/5: 可维护性 Maintainability.
 *
 * Comment ratio, naming convention violations, TypeScript `any` leakage,
 * TODO/FIXME rot markers, and dead-code smells (exports vs declared symbols).
 */

import type { AnalyzedFile, Finding, MetricEntry, Severity } from '../types.js'
import { collectCommentLines, walkAst, type BabelFile, type BabelNode } from './parser.js'

export interface MaintainabilityResult {
  score: number
  findings: Finding[]
  metrics: MetricEntry[]
}

/** Count lines of code excluding blanks and comments. */
export function countSloc(code: string, commentLines: number): number {
  const total = code.split('\n').filter((line) => line.trim().length > 0).length
  return Math.max(0, total - commentLines)
}

/** TS `any` keyword occurrences in the AST. */
function countAny(ast: BabelFile | null, code: string): number {
  if (!ast) return (code.match(/\bany\b/g)?.length ?? 0)
  let count = 0
  walkAst(ast, (node) => {
    if (node.type === 'TSAnyKeyword') count++
    if (node.type === 'TSAsExpression') {
      const expression = (node as Record<string, unknown>).typeAnnotation as BabelNode | undefined
      if (expression?.type === 'TSAnyKeyword') count++
    }
    return false
  })
  return count
}

function snakeInMiddle(name: string): boolean {
  const body = name.replace(/^_+/, '').replace(/_+$/, '')
  return /[a-z0-9]_[a-z0-9]/.test(body) || /[a-z0-9]_[A-Z]/.test(body)
}

/** Per-file naming violations (capped so huge files don't flood the report). */
function namingViolations(ast: BabelFile | null, filePath: string, findings: Finding[], capPerFile = 5): number {
  if (!ast) return 0
  let violations = 0
  let pushed = 0

  const report = (node: BabelNode, name: string, issue: string, rule: string, severity: Severity): void => {
    violations++
    if (pushed < capPerFile) {
      pushed++
      findings.push({
        dimension: 'maintainability',
        severity,
        rule,
        message: `${issue}: "${name}" — 命名规范偏离 ${rule === 'MNT-001' ? '驼峰命名' : '大驼峰类命名'}`,
        line: node.loc?.start.line ?? 0,
        file: filePath,
      })
    }
  }

  walkAst(ast, (node) => {
    if (node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration') {
      const id = (node as Record<string, unknown>).id as BabelNode | undefined
      const name = (id as Record<string, unknown> | undefined)?.name as string | undefined
      if (name && snakeInMiddle(name)) {
        report(node, name, 'snake_case in JS/TS identifier', 'MNT-001', 'minor')
      }
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const id = (node as Record<string, unknown>).id as BabelNode | undefined
      const name = (id as Record<string, unknown> | undefined)?.name as string | undefined
      if (name && !/^[A-Z]/.test(name)) {
        report(node, name, 'class not PascalCase', 'MNT-002', 'minor')
      }
    }
    if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') {
      const id = (node as Record<string, unknown>).id as BabelNode | undefined
      const name = (id as Record<string, unknown> | undefined)?.name as string | undefined
      if (name && !/^[A-Z]/.test(name)) {
        report(node, name, 'type not PascalCase', 'MNT-002', 'minor')
      }
    }
    return false
  })
  return violations
}

function todoMarkers(code: string, commentLines: number[], filePath: string, findings: Finding[], cap = 5): number {
  let count = 0
  let pushed = 0
  for (let index = 0; index < commentLines.length && pushed < cap; index++) {
    // commentLines entries are 1-based; the split array is 0-based.
    const line = code.split('\n')[commentLines[index]! - 1]
    if (!line) continue
    const match = line.match(/\b(TODO|FIXME|HACK|XXX)\b/) // eslint-disable-line no-useless-escape
    if (match) {
      count++
      pushed++
      findings.push({
        dimension: 'maintainability',
        severity: 'minor',
        rule: 'MNT-003',
        message: `${match[0]} marker rot markers left in code — 待处理标记积压`,
        line: commentLines[index],
        file: filePath,
      })
    }
  }
  return count
}

export function analyzeMaintainability(files: AnalyzedFile[]): MaintainabilityResult {
  const findings: Finding[] = []

  let sloc = 0
  let commentLinesTotal = 0
  let anyCount = 0
  let namingCount = 0
  let todoCount = 0
  let exported = 0
  let declared = 0
  let longFiles = 0

  for (const file of files) {
    const commentLines = collectCommentLines(file.ast ?? null, file.code)
    const fileSloc = countSloc(file.code, commentLines.length)
    const lineCount = file.code.split('\n').length

    sloc += fileSloc
    commentLinesTotal += commentLines.length

    if (lineCount > 1000) {
      longFiles++
      findings.push({
        dimension: 'maintainability',
        severity: 'major',
        rule: 'MNT-004',
        message: `File spans ${lineCount} lines — 单文件超 1000 行，按职责拆分模块`,
        file: file.path,
        line: 1,
      })
    } else if (lineCount > 400) {
      longFiles++
      findings.push({
        dimension: 'maintainability',
        severity: 'minor',
        rule: 'MNT-004',
        message: `File spans ${lineCount} lines — 单文件偏大，考虑拆分`,
        file: file.path,
        line: 1,
      })
    }

    anyCount += countAny(file.ast ?? null, file.code)
    namingCount += namingViolations(file.ast ?? null, file.path, findings)
    todoCount += todoMarkers(file.code, commentLines, file.path, findings)

    // Exported vs declared symbols — dead-code surface proxy.
    if (file.ast) {
      walkAst(file.ast, (node) => {
        if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration') {
          exported++
        }
        if (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclaration' || node.type === 'ClassDeclaration') {
          declared++
        }
        return false
      })
    }
  }

  const commentRatio = sloc > 0 ? commentLinesTotal / sloc : 0
  const anyRatio = declared > 0 ? anyCount / Math.max(1, declared) : anyCount > 0 ? 1 : 0
  const exportRatio = declared > 0 ? Math.min(1, exported / declared) : 1
  const longFileRatio = files.length > 0 ? longFiles / files.length : 0

  // Scoring
  let score = 100
  if (commentRatio < 0.05) score -= 12
  else if (commentRatio < 0.1) score -= 6
  score -= Math.min(10, namingCount * 1.5)
  score -= Math.min(18, anyRatio * 90)
  score -= Math.min(8, todoCount)
  score -= Math.min(15, longFileRatio * 60)
  if (declared > 5 && exportRatio < 0.1) {
    score -= 6
    findings.push({
      dimension: 'maintainability',
      severity: 'info',
      rule: 'MNT-005',
      message: 'Almost nothing is exported while many symbols are declared — 疑似内部死代码',
    })
  }

  const metrics: MetricEntry[] = [
    { key: 'sloc 代码行', value: sloc },
    { key: 'comment lines 注释行', value: commentLinesTotal },
    { key: 'comment ratio 注释率', value: `${(commentRatio * 100).toFixed(1)}%` },
    { key: 'any usage any 使用', value: anyCount },
    { key: 'naming violations 命名违规', value: namingCount },
    { key: 'TODO/FIXME', value: todoCount },
    { key: 'export ratio 导出率', value: `${(exportRatio * 100).toFixed(0)}%` },
    { key: 'oversized files 超大文件', value: longFiles },
  ]

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    findings,
    metrics,
  }
}
