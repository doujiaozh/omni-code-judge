/**
 * judge_core — Dimension 2/5: 安全性 Security.
 *
 * Red-line scanners for code injection (eval / new Function / innerHTML),
 * hardcoded credentials, weak crypto, SQL injection through string concat,
 * and plaintext transport. AST-first with a regex fallback so even
 * unparseable exotic syntax still gets scanned — security never degrades
 * to "unknown" silently.
 */

import type { AnalyzedFile, Finding, MetricEntry, Severity } from '../types.js'
import { stripStrings, walkAst, type BabelFile, type BabelNode } from './parser.js'

export interface SecurityResult {
  score: number
  findings: Finding[]
  metrics: MetricEntry[]
}

const SECRET_NAME_PATTERN =
  /^(.*?)(password|passwd|secret|token|apikey|api_key|accesskey|access_key|privatekey|private_key|auth|credential|passwd_hash)$/i

const HASHAlgorithms = new Set(['md5', 'sha1', 'sha-1', 'md4'])

function isStringLiteral(node: BabelNode | null | undefined): node is BabelNode & { value: string } {
  return node?.type === 'StringLiteral'
}

function calleeName(node: BabelNode): string {
  const callee = (node as Record<string, unknown>).callee
  if (!callee || typeof callee !== 'object') return ''
  const c = callee as BabelNode
  if (c.type === 'Identifier') return (c as Record<string, unknown>).name as string
  if (c.type === 'MemberExpression') {
    const object = (c as Record<string, unknown>).object as BabelNode | undefined
    const property = (c as Record<string, unknown>).property as BabelNode | undefined
    const objName = object?.type === 'Identifier' ? ((object as Record<string, unknown>).name as string) : ''
    const propName =
      property?.type === 'Identifier'
        ? ((property as Record<string, unknown>).name as string)
        : property?.type === 'StringLiteral'
          ? ((property as Record<string, unknown>).value as string)
          : ''
    return propName ? `${objName}.${propName}` : objName
  }
  return ''
}

function propertyAccess(node: BabelNode): string {
  const property = (node as Record<string, unknown>).property
  if (!property || typeof property !== 'object') return ''
  const p = property as BabelNode
  if (p.type === 'Identifier') return (p as Record<string, unknown>).name as string
  if (p.type === 'StringLiteral') return (p as Record<string, unknown>).value as string
  return ''
}

function identifierOf(node: BabelNode | unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as BabelNode
  if (n.type === 'Identifier') {
    const name = (n as Record<string, unknown>).name
    return typeof name === 'string' ? name : ''
  }
  if (n.type === 'MemberExpression') return propertyAccess(n)
  return ''
}

/** Scan one file's AST for security red lines. */
function scanAst(ast: BabelFile | null, findings: Finding[], filePath: string): void {
  if (!ast) return

  walkAst(ast, (node) => {
    const type = node.type

    // --- eval-family code injection ------------------------------------
    if (type === 'CallExpression') {
      const name = calleeName(node)
      const args = (node as Record<string, unknown>).arguments as BabelNode[]
      const firstArg = args?.[0]

      if (name === 'eval' || name === 'execScript') {
        push(findings, filePath, node, 'SEC-001', 'critical', 'eval() executes attacker-controllable strings — 代码注入红线，禁止使用 eval')
      }
      if (name === 'setTimeout' || name === 'setInterval') {
        if (firstArg && isStringLiteral(firstArg)) {
          push(findings, filePath, node, 'SEC-002', 'major', 'Timer with a string argument is implicit eval — 定时器传字符串等价于 eval')
        }
      }
      if (name.endsWith('.write') || name.endsWith('.writeln')) {
        const obj = calleeObjectName(node)
        if (obj === 'document' || name.startsWith('document.')) {
          push(findings, filePath, node, 'SEC-003', 'major', 'document.write injects raw markup — DOM 注入风险，改用 textContent')
        }
      }
      if (name.endsWith('.insertAdjacentHTML')) {
        push(findings, filePath, node, 'SEC-004', 'major', 'insertAdjacentHTML writes unsanitized markup — 未消毒 HTML 注入')
      }
      // weak hashes
      if (name.endsWith('.createHash') && firstArg && isStringLiteral(firstArg)) {
        const algo = firstArg.value.toLowerCase()
        if (HASHAlgorithms.has(algo)) {
          push(findings, filePath, node, 'SEC-005', 'major', `Weak hash algorithm ${algo} — 弱摘要算法，迁移到 sha-256+`)
        }
      }
      // child_process shell injection
      if (name.endsWith('.exec') || name.endsWith('.execSync') || name.endsWith('.spawn')) {
        if (firstArg && (firstArg.type === 'BinaryExpression' || firstArg.type === 'TemplateLiteral')) {
          push(findings, filePath, node, 'SEC-006', 'critical', 'Shell command built by string concatenation — 命令注入风险，使用参数数组形式')
        }
      }
    }

    if (type === 'NewExpression') {
      const name = calleeName(node)
      if (name === 'Function') {
        push(findings, filePath, node, 'SEC-007', 'critical', 'new Function() compiles strings at runtime — 动态代码执行红线')
      }
    }

    // --- DOM XSS sinks --------------------------------------------------
    if (type === 'AssignmentExpression') {
      const left = (node as Record<string, unknown>).left as BabelNode | undefined
      if (left?.type === 'MemberExpression') {
        const prop = propertyAccess(left)
        if (prop === 'innerHTML' || prop === 'outerHTML') {
          push(findings, filePath, node, 'SEC-008', 'critical', `Direct ${prop} assignment — XSS 注入红线，使用 textContent 或消毒库`)
        }
      }
      // hardcoded credentials: const password = "hunter2"
      const idName = identifierOf(left)
      const right = (node as Record<string, unknown>).right as BabelNode | undefined
      if (idName && SECRET_NAME_PATTERN.test(idName)) {
        if (isStringLiteral(right) && right.value.length >= 4) {
          push(findings, filePath, node, 'SEC-009', 'critical', `Hardcoded credential in "${idName}" — 硬编码密钥/密码，必须走环境变量或密钥管理`)
        }
      }
    }

    if (type === 'VariableDeclarator') {
      const id = (node as Record<string, unknown>).id as BabelNode | undefined
      const init = (node as Record<string, unknown>).init as BabelNode | undefined
      const idName = identifierOf(id)
      if (idName && SECRET_NAME_PATTERN.test(idName) && isStringLiteral(init) && init.value.length >= 4) {
        push(findings, filePath, node, 'SEC-009', 'critical', `Hardcoded credential "${idName}" — 硬编码密钥/密码，必须走环境变量`)
      }
    }

    // React dangerouslySetInnerHTML
    if (type === 'JSXAttribute') {
      const name = (node as Record<string, unknown>).name as BabelNode | undefined
      const attrName = name ? ((name as Record<string, unknown>).name as string) : ''
      if (attrName === 'dangerouslySetInnerHTML') {
        push(findings, filePath, node, 'SEC-010', 'major', 'dangerouslySetInnerHTML bypasses React XSS protection — 绕过 React 转义')
      }
    }

    // SQL string concatenation
    if (type === 'BinaryExpression' && ((node as Record<string, unknown>).operator as string) === '+') {
      const text = literalText(node)
      if (/\b(select|insert\s+into|update|delete\s+from)\b/i.test(text)) {
        push(findings, filePath, node, 'SEC-011', 'major', 'SQL built by string concatenation — SQL 注入风险，使用参数化查询')
      }
    }

    return false
  })
}

function calleeObjectName(node: BabelNode): string {
  const callee = (node as Record<string, unknown>).callee
  if (!callee || typeof callee !== 'object') return ''
  const object = (callee as Record<string, unknown>).object
  if (!object || typeof object !== 'object') return ''
  return ((object as Record<string, unknown>).name as string) ?? ''
}

function literalText(node: BabelNode): string {
  const type = node.type
  if (type === 'StringLiteral' || type === 'TemplateLiteral') {
    const value = (node as Record<string, unknown>).value
    return typeof value === 'string' ? value : ''
  }
  const out: string[] = []
  for (const key of Object.keys(node)) {
    const child = (node as Record<string, unknown>)[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object') out.push(literalText(item as BabelNode))
      }
    } else if (child && typeof child === 'object') {
      out.push(literalText(child as BabelNode))
    }
  }
  return out.join(' ')
}

/** Regex fallback: catches the same red lines without an AST. */
function scanRegex(code: string, findings: Finding[], filePath: string): void {
  const stripped = stripStrings(code)
  const lines = stripped.split('\n')

  const rules: Array<[RegExp, string, Severity, string]> = [
    [/\beval\s*\(/, 'SEC-001', 'critical', 'eval() — 代码注入红线（正则回退扫描）'],
    [/new\s+Function\s*\(/, 'SEC-007', 'critical', 'new Function() — 动态代码执行（正则回退扫描）'],
    [/\.innerHTML\s*=/, 'SEC-008', 'critical', 'innerHTML assignment — XSS 红线（正则回退扫描）'],
    [/\bdocument\s*\.\s*write(ln)?\s*\(/, 'SEC-003', 'major', 'document.write — DOM 注入（正则回退扫描）'],
    [/(password|passwd|secret|token|api_?key)\s*[:=]\s*['"][^'"]{4,}['"]/i, 'SEC-009', 'critical', 'Hardcoded credential — 硬编码凭据（正则回退扫描）'],
    [/\bsetTimeout\s*\(\s*['"]/, 'SEC-002', 'major', 'Timer string argument — 隐式 eval（正则回退扫描）'],
    [/createHash\s*\(\s*['"](md5|sha1?)['"]/i, 'SEC-005', 'major', 'Weak hash — 弱摘要算法（正则回退扫描）'],
    [/\.\s*(exec|execSync|spawn)\s*\([^)]*['"`]\s*\+/, 'SEC-006', 'major', 'Concatenated shell command — 命令注入（正则回退扫描）'],
    [/dangerouslySetInnerHTML/, 'SEC-010', 'major', 'dangerouslySetInnerHTML — 绕过 XSS 防护（正则回退扫描）'],
  ]

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    for (const [pattern, rule, severity, message] of rules) {
      if (pattern.test(line)) {
        const already = findings.some((finding) => finding.line === index + 1 && finding.rule === rule)
        if (!already) {
          findings.push({
            dimension: 'security',
            severity,
            rule,
            message,
            line: index + 1,
            file: filePath,
          })
        }
      }
    }
  }

  // Plaintext transport inside the original (non-stripped) source.
  const originalLines = code.split('\n')
  for (let index = 0; index < originalLines.length; index++) {
    const line = originalLines[index]
    if (/https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/.test(line) && /:\/\//.test(line)) {
      if (/^http:\/\//.test(line.trim()) || /\bhttps?:\/\/[^'"\s]*:.*@/i.test(line)) {
        findings.push({
          dimension: 'security',
          severity: 'major',
          rule: 'SEC-012',
          message: 'Plaintext http:// URL or embedded credentials — 明文传输/URL 内联凭据',
          line: index + 1,
          file: filePath,
        })
      }
    }
  }
}

function push(
  findings: Finding[],
  filePath: string,
  node: BabelNode,
  rule: string,
  severity: Severity,
  message: string,
): void {
  const line = node.loc?.start.line ?? 0
  if (findings.some((finding) => finding.line === line && finding.rule === rule && finding.file === filePath)) return
  findings.push({ dimension: 'security', severity, rule, message, line, file: filePath })
}

export function analyzeSecurity(files: AnalyzedFile[]): SecurityResult {
  const findings: Finding[] = []

  for (const file of files) {
    scanAst(file.ast ?? null, findings, file.path)
    // Regex pass always runs: it catches literals the AST visitor skipped
    // (e.g. plaintext URLs) and fully covers parse-failed files.
    scanRegex(file.code, findings, file.path)
  }

  // Deduplicate (AST + regex can both fire on the same line/rule).
  const seen = new Set<string>()
  const deduped = findings.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.rule}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let score = 100
  for (const finding of deduped) {
    score -= finding.severity === 'critical' ? 35 : finding.severity === 'major' ? 18 : finding.severity === 'minor' ? 7 : 2
  }
  // One critical red line caps the dimension: a single eval is a fail.
  if (deduped.some((finding) => finding.severity === 'critical')) {
    score = Math.min(score, 45)
  }

  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 }
  for (const finding of deduped) counts[finding.severity]++

  const metrics: MetricEntry[] = [
    { key: 'criticals 致命', value: counts.critical },
    { key: 'majors 严重', value: counts.major },
    { key: 'minors 轻微', value: counts.minor },
    { key: 'total findings', value: deduped.length },
  ]

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    findings: deduped,
    metrics,
  }
}
