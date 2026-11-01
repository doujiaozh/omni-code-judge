/**
 * Smoke tests for Omni-Code-Judge — pure node:test, zero extra dependencies.
 *
 * Run:  npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { judge } from '../src/judge.js'
import { runStaticAnalysis } from '../src/core/index.js'
import { detectLanguage, isDiffText, parseDiff, parseSource, stripStrings } from '../src/core/parser.js'
import { renderMarkdownReport } from '../src/report/markdown.js'
import { renderRadarHtml } from '../src/report/radar.js'

const here = dirname(fileURLToPath(import.meta.url))
// Walk up to the project root (tests run from both tests/ and dist/tests/).
let root = here
while (!existsSync(resolve(root, 'package.json')) || !existsSync(resolve(root, 'examples'))) {
  const parent = dirname(root)
  if (parent === root) throw new Error('project root not found')
  root = parent
}
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8')

const badCode = read('examples/bad-code.ts')
const goodCode = read('examples/good-code.ts')

test('parser: detects languages by extension', () => {
  assert.equal(detectLanguage('a.ts'), 'ts')
  assert.equal(detectLanguage('a.tsx'), 'tsx')
  assert.equal(detectLanguage('a.js'), 'js')
  assert.equal(detectLanguage('a.jsx'), 'jsx')
  assert.equal(detectLanguage('a.md'), 'unknown')
})

test('parser: parseSource never throws on broken input', () => {
  const outcome = parseSource('function {{{ totally broken', 'ts')
  assert.ok(outcome.ast || outcome.error)
})

test('parser: parseSource parses valid TypeScript', () => {
  const { ast, error } = parseSource('const x: number = 1', 'ts')
  assert.equal(error, undefined)
  assert.equal(ast?.type, 'File')
})

test('parser: stripStrings preserves the line grid and kills content', () => {
  const source = ['/* multi', ' * line', ' */', "const s = 'eval(1)' // eval(", 'const x = 1'].join('\n')
  const stripped = stripStrings(source)
  assert.equal(stripped.split('\n').length, source.split('\n').length)
  assert.ok(!stripped.includes('eval'))
})

test('parser: recognizes and splits unified diffs', () => {
  const diff = ['diff --git a/foo.ts b/foo.ts', 'index 111..222 100644', '--- a/foo.ts', '+++ b/foo.ts', '@@ -1 +1 @@', '-const old = 1', '+const fresh = 2', ' context line'].join('\n')
  assert.equal(isDiffText(diff), true)
  const chunks = parseDiff(diff)
  assert.equal(chunks.length, 1)
  assert.match(chunks[0]!.path, /foo\.ts/)
  assert.ok(chunks[0]!.code.includes('const fresh = 2'))
})

test('core: bad code earns red cards and a failing grade', async () => {
  const result = await judge(badCode, {})
  assert.ok(result.redCards >= 4, `expected >= 4 red cards, got ${result.redCards}`)
  assert.ok(['D', 'F'].includes(result.grade), `expected D/F grade, got ${result.grade}`)
  const rules = result.findings.map((finding) => finding.rule)
  for (const expected of ['SEC-001', 'SEC-008', 'SEC-009']) {
    assert.ok(rules.includes(expected), `expected rule ${expected} to fire`)
  }
  assert.ok(result.dimensions.find((dimension) => dimension.dimension === 'security')!.score < 50)
})

test('core: good code scores far better than bad code', async () => {
  const good = await judge(goodCode, {})
  const bad = await judge(badCode, {})
  assert.ok(good.total > bad.total + 30, `good=${good.total} should beat bad=${bad.total} by a wide margin`)
  assert.equal(good.redCards, 0)
})

test('core: complexity flags the deep-nesting monster', async () => {
  const result = await judge(badCode, {})
  const complexityFindings = result.findings.filter((finding) => finding.rule.startsWith('CPL-'))
  assert.ok(complexityFindings.length >= 2)
})

test('core: maintainability detects snake_case, any and TODOs', async () => {
  const result = await judge(badCode, {})
  const rules = result.findings.map((finding) => finding.rule)
  assert.ok(rules.includes('MNT-003'), 'TODO/FIXME markers expected')
  const maintainability = result.dimensions.find((dimension) => dimension.dimension === 'maintainability')!
  const anyMetric = maintainability.metrics.find((metric) => String(metric.key).includes('any'))
  assert.ok(anyMetric, 'any-usage metric expected')
})

test('core: design detects the god class anti-pattern', async () => {
  const result = await judge(badCode, {})
  const antiPatterns = result.patterns.filter((pattern) => pattern.kind === 'anti')
  assert.ok(antiPatterns.length >= 2, `expected >= 2 anti-patterns, got ${antiPatterns.length}`)
  assert.ok(antiPatterns.some((pattern) => pattern.name.includes('God Class')))
})

test('core: directory target scans multiple files', async () => {
  const analysis = runStaticAnalysis(resolve(root, 'examples'), { cwd: root })
  assert.ok(analysis.files.length >= 2)
  assert.ok(analysis.metrics.loc > 100)
})

test('report: markdown report renders a full battle report', async () => {
  const result = await judge(badCode, {})
  const markdown = renderMarkdownReport(result)
  assert.match(markdown, /架构审查战报/)
  assert.match(markdown, /红黄牌警告/)
  assert.match(markdown, /SEC-009/)
  assert.match(markdown, /五维评级/)
  assert.ok(markdown.length > 3000)
})

test('report: pure-CSS radar chart is self-contained HTML', async () => {
  const result = await judge(goodCode, {})
  const radar = renderRadarHtml(result.dimensions, 300)
  assert.match(radar, /class="omni-radar"/)
  assert.match(radar, /clip-path:polygon/)
  assert.ok(!radar.includes('<svg'), 'radar must be pure CSS, not SVG')
  assert.ok(!radar.includes('<script'))
})
