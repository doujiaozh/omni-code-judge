/**
 * judge_core — Dimension 5/5: 设计模式 Design Patterns.
 *
 * Structural pattern recognition over the AST (sans LLM): the static half of
 * the "设计模式" dimension. The AI architect layer may confirm or challenge
 * these signals afterwards.
 *
 * Positive signals: singleton, factory, observer, strategy, adapter, facade,
 * dependency injection, decorator, iterator, command.
 * Anti-patterns: god class, global mutable state, import explosion, export
 * promiscuity (kitchen-sink module).
 */
import { walkAst } from './parser.js'
import type { BabelNode } from './parser.js'
import type { AnalyzedFile, DetectedPattern, Finding, MetricEntry } from '../types.js'

const FACTORY_NAME = /^(?:create|make|build|from|of|with|new)\w*$/i
const OBSERVER_SUB = /^(?:subscribe|on|addListener|addEventListener|off|unsubscribe|removeListener)$/
const OBSERVER_PUB = /^(?:emit|publish|dispatch|notify|trigger|fire)$/
const STRATEGY_HOLDER =
  /^(?:strateg(?:y|ies)|handlers?|processors?|resolvers?|serializers?|parsers?|renderers?|backends?|providers?|adapters?|factories|registry|registryMap|map)$/i

interface ClassInfo {
  name: string
  node: BabelNode
  methods: Set<string>
  statics: Set<string>
  decorators: number
  constructorParams: number
  storedConstructorParams: number
  bodyLines: number
  file: string
}

interface FileInfo {
  imports: number
  topMutable: number
  exportedTopLevel: number
}

export interface DesignResult {
  score: number
  patterns: DetectedPattern[]
  findings: Finding[]
  metrics: MetricEntry[]
}

function scanClass(filePath: string, node: BabelNode): ClassInfo {
  const info: ClassInfo = {
    name: ((node as Record<string, unknown>).id as Record<string, unknown> | undefined)?.name as string | undefined ?? '<class>',
    node,
    methods: new Set<string>(),
    statics: new Set<string>(),
    decorators: 0,
    constructorParams: 0,
    storedConstructorParams: 0,
    bodyLines: 0,
    file: filePath,
  }

  const body = (node as Record<string, unknown>).body as BabelNode | null
  const start = node.loc?.start.line ?? 0
  const end = node.loc?.end.line ?? start
  info.bodyLines = end - start + 1

  if (body) {
    walkAst(body, (member) => {
      if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
        const name = ((member as Record<string, unknown>).key as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          info.methods.add(name)
          if ((member as Record<string, unknown>).static === true) info.statics.add(name)
        }
        const decorators = (member as Record<string, unknown>).decorators
        if (Array.isArray(decorators)) info.decorators += decorators.length
      }
      if (member.type === 'ClassProperty' && (member as Record<string, unknown>).static === true) {
        const name = ((member as Record<string, unknown>).key as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) info.statics.add(name)
      }
      return false
    })
  }

  // Constructor parameters stored as fields → adapter/DI signal.
  if (info.methods.has('constructor') && body) {
    walkAst(body, (member) => {
      if (member.type !== 'ClassMethod') return false
      const key = (member as Record<string, unknown>).key as Record<string, unknown> | undefined
      if (key?.name !== 'constructor') return false
      const params = (member as Record<string, unknown>).params as BabelNode[] | undefined
      info.constructorParams = params?.length ?? 0
      const paramNames = new Set(
        (params ?? [])
          .map((param) => ((param as Record<string, unknown>).name as string | undefined) ?? '')
          .filter(Boolean),
      )
      walkAst(member, (inner) => {
        if (inner.type !== 'AssignmentExpression') return false
        const left = (inner as Record<string, unknown>).left as BabelNode | undefined
        const right = (inner as Record<string, unknown>).right as BabelNode | undefined
        if (left?.type !== 'MemberExpression') return false
        const target = ((left as Record<string, unknown>).object as Record<string, unknown> | undefined)?.name
        if (target !== 'this') return false
        if (right?.type === 'Identifier' && paramNames.has(((right as Record<string, unknown>).name as string | undefined) ?? '')) {
          info.storedConstructorParams++
        } else if (right?.type === 'MemberExpression') {
          const source = ((right as Record<string, unknown>).object as Record<string, unknown> | undefined)?.name
          if (source && paramNames.has(source as string)) info.storedConstructorParams++
        }
        return false
      })
      return true
    })
  }

  return info
}

/** Class-level patterns: singleton / DI / adapter / observer / command / decorator + the god-class anti-pattern. */
function scanClassPatterns(classes: ClassInfo[], patterns: DetectedPattern[]): void {
  for (const klass of classes) {
    const hasGetInstance = [...klass.statics].some((method) => /getInstance|instance/.test(method))
    const hasStaticInstance = [...klass.statics].some((prop) => /instance|default/i.test(prop))
    if (hasGetInstance || hasStaticInstance) {
      patterns.push({
        name: 'Singleton 单例',
        kind: 'creational',
        confidence: hasGetInstance ? 0.9 : 0.7,
        evidence: `class ${klass.name} exposes a static instance accessor`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }

    if (klass.constructorParams >= 3 && klass.storedConstructorParams >= 2) {
      patterns.push({
        name: 'Dependency Injection 依赖注入',
        kind: 'structural',
        confidence: 0.7,
        evidence: `class ${klass.name} stores ${klass.storedConstructorParams} constructor-provided dependencies`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }

    if (klass.constructorParams === 1 && klass.storedConstructorParams >= 1) {
      patterns.push({
        name: 'Adapter / Wrapper 适配器',
        kind: 'structural',
        confidence: 0.55,
        evidence: `class ${klass.name} wraps a single injected collaborator`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }

    const subs = [...klass.methods].filter((method) => OBSERVER_SUB.test(method))
    const pubs = [...klass.methods].filter((method) => OBSERVER_PUB.test(method))
    if (subs.length > 0 && pubs.length > 0) {
      patterns.push({
        name: 'Observer / Pub-Sub 观察者',
        kind: 'behavioral',
        confidence: 0.75,
        evidence: `class ${klass.name} pairs ${subs.join('/')} with ${pubs.join('/')}`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }

    if ([...klass.methods].includes('execute') || [...klass.methods].includes('run')) {
      patterns.push({
        name: 'Command 命令',
        kind: 'behavioral',
        confidence: 0.5,
        evidence: `class ${klass.name} exposes a single execute()/run() entry`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }

    if (klass.decorators > 0) {
      patterns.push({
        name: 'Decorator 装饰器',
        kind: 'structural',
        confidence: 0.85,
        evidence: `${klass.decorators} decorator binding(s) on class ${klass.name}`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }

    // God class — anti-pattern
    if (klass.methods.size >= 20 || klass.bodyLines >= 400) {
      patterns.push({
        name: 'God Class 上帝类',
        kind: 'anti',
        confidence: 0.85,
        evidence: `class ${klass.name} carries ${klass.methods.size} methods over ${klass.bodyLines} lines`,
        file: klass.file,
        line: klass.node.loc?.start.line ?? 0,
      })
    }
  }
}

/** Module-level patterns: factory / iterator / module singleton / strategy registry. */
function scanModulePatterns(file: AnalyzedFile, patterns: DetectedPattern[]): void {
  walkAst(file.ast, (node) => {
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression'
    ) {
      const name =
        (((node as Record<string, unknown>).id as Record<string, unknown> | undefined)?.name as string | undefined) ?? ''

      let spawnsNew = false
      walkAst(node, (inner) => {
        if (inner.type === 'NewExpression') spawnsNew = true
        return false
      })
      if (FACTORY_NAME.test(name) && spawnsNew) {
        patterns.push({
          name: 'Factory 工厂',
          kind: 'creational',
          confidence: 0.7,
          evidence: `function ${name}() constructs instances`,
          file: file.path,
          line: node.loc?.start.line ?? 0,
        })
      }
    }
    if (node.type === 'YieldExpression') {
      patterns.push({
        name: 'Iterator / Generator 迭代器',
        kind: 'behavioral',
        confidence: 0.6,
        evidence: 'generator yield inside function',
        file: file.path,
        line: node.loc?.start.line ?? 0,
      })
    }
    if (node.type === 'CallExpression') {
      const callee = (node as Record<string, unknown>).callee as BabelNode | undefined
      if (callee?.type === 'MemberExpression') {
        const property = (callee as Record<string, unknown>).property as Record<string, unknown> | undefined
        const propName = property?.name as string | undefined
        if (propName === 'freeze') {
          const args = (node as Record<string, unknown>).arguments as BabelNode[] | undefined
          if (args?.[0]?.type === 'ObjectExpression') {
            patterns.push({
              name: 'Module Singleton 模块单例',
              kind: 'creational',
              confidence: 0.7,
              evidence: 'Object.freeze() over an object literal',
              file: file.path,
              line: node.loc?.start.line ?? 0,
            })
          }
        }
      }
    }
    if (node.type === 'VariableDeclarator') {
      const id = (node as Record<string, unknown>).id as BabelNode | undefined
      const name = ((id as Record<string, unknown> | undefined)?.name as string | undefined) ?? ''
      const init = (node as Record<string, unknown>).init as BabelNode | undefined
      if (name && STRATEGY_HOLDER.test(name)) {
        if (init?.type === 'ObjectExpression' || init?.type === 'NewExpression') {
          patterns.push({
            name: 'Strategy / Registry 策略注册表',
            kind: 'behavioral',
            confidence: 0.65,
            evidence: `variable "${name}" maps keys to implementations`,
            file: file.path,
            line: node.loc?.start.line ?? 0,
          })
        }
      }
    }
    return false
  })
}

/** Module-level anti-patterns: global mutable state / import explosion / kitchen-sink module. */
function scanModuleAntiPatterns(file: AnalyzedFile, info: FileInfo, patterns: DetectedPattern[]): void {
  if (info.topMutable >= 3) {
    patterns.push({
      name: 'Global Mutable State 全局可变状态',
      kind: 'anti',
      confidence: 0.6,
      evidence: `${info.topMutable} top-level let/var declarations`,
      file: file.path,
      line: 1,
    })
  }
  if (info.imports >= 20) {
    patterns.push({
      name: 'Import Explosion 导入爆炸',
      kind: 'anti',
      confidence: 0.7,
      evidence: `${info.imports} imports in one module`,
      file: file.path,
      line: 1,
    })
  }
  if (info.exportedTopLevel >= 15) {
    patterns.push({
      name: 'Kitchen-Sink Module 万能模块',
      kind: 'anti',
      confidence: 0.6,
      evidence: `${info.exportedTopLevel} exports in one module`,
      file: file.path,
      line: 1,
    })
  }
}

export function scanDesign(file: AnalyzedFile): DetectedPattern[] {
  const patterns: DetectedPattern[] = []
  if (!file.ast) return patterns

  const info: FileInfo = {
    imports: 0,
    topMutable: 0,
    exportedTopLevel: 0,
  }

  const classes: ClassInfo[] = []

  walkAst(file.ast, (node, parent) => {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      classes.push(scanClass(file.path, node))
    }
    if (node.type === 'ImportDeclaration' || node.type === 'TSImportType' || node.type === 'ImportExpression') {
      info.imports++
    }
    // `export var x = …` wraps the declaration in an ExportNamedDeclaration.
    const isTopLevel =
      parent?.type === 'Program' ||
      parent?.type === 'ExportNamedDeclaration' ||
      parent?.type === 'ExportDefaultDeclaration'
    if (node.type === 'VariableDeclaration' && isTopLevel) {
      if ((node as Record<string, unknown>).kind === 'let' || (node as Record<string, unknown>).kind === 'var') {
        info.topMutable++
      }
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') info.exportedTopLevel++
    return false
  })

  // --- positive patterns -------------------------------------------------

  scanClassPatterns(classes, patterns)

  // Module-level patterns: factory / strategy / iterator / singleton-module.
  scanModulePatterns(file, patterns)

  // Anti-patterns at module level
  scanModuleAntiPatterns(file, info, patterns)

  // Deduplicate identical (file, line, name) hits.
  const seen = new Set<string>()
  return patterns.filter((pattern) => {
    const key = `${pattern.file}:${pattern.line}:${pattern.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function analyzeDesign(files: AnalyzedFile[]): DesignResult {
  const patterns: DetectedPattern[] = []
  const findings: Finding[] = []

  for (const file of files) {
    patterns.push(...scanDesign(file))
  }

  const positive = patterns.filter((pattern) => pattern.kind !== 'anti')
  const anti = patterns.filter((pattern) => pattern.kind === 'anti')

  for (const pattern of anti) {
    const severity = pattern.name === 'God Class 上帝类' ? 'major' : pattern.name === 'Global Mutable State 全局可变状态' ? 'major' : 'minor'
    findings.push({
      dimension: 'designPatterns',
      severity,
      rule: pattern.name.startsWith('God Class') ? 'PAT-001' : pattern.name.startsWith('Global') ? 'PAT-002' : 'PAT-003',
      message: `${pattern.name} — ${pattern.evidence}`,
      file: pattern.file,
      line: pattern.line,
    })
  }

  let score = 55 // neutral baseline: neither patterned nor pattern-less
  score += Math.min(25, positive.length * 5) // deliberate structure gets credit
  score += positive.length > 0 ? 6 : 0
  score -= Math.min(35, anti.reduce((sum, pattern) => sum + (pattern.confidence >= 0.8 ? 15 : 8), 0))
  if (anti.some((pattern) => pattern.confidence >= 0.8)) score = Math.min(score, 70)

  const byKind: Record<string, number> = {}
  for (const pattern of patterns) byKind[pattern.kind] = (byKind[pattern.kind] ?? 0) + 1

  const metrics = [
    { key: 'detected patterns 检出模式', value: patterns.length },
    { key: 'creational 创建型', value: byKind.creational ?? 0 },
    { key: 'structural 结构型', value: byKind.structural ?? 0 },
    { key: 'behavioral 行为型', value: byKind.behavioral ?? 0 },
    { key: 'anti-patterns 反模式', value: anti.length },
  ]

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    patterns,
    findings,
    metrics,
  }
}
