/**
 * judge_ai — prompt engineering for the principal-architect review.
 *
 * The LLM is cast as a ruthlessly pragmatic staff engineer: it must score all
 * five dimensions, name the design patterns it sees, and enumerate business
 * risks — always as ONE strict JSON object, no prose, no markdown fences.
 */

import type { Finding, StaticMetrics } from '../types.js'
import type { StaticAnalysis } from '../core/index.js'

export const ARCHITECT_SYSTEM_PROMPT = `You are a principal software architect with 20 years of experience auditing real production systems. You review code the way a brutal-but-fair technical committee would: precise, evidence-based, no flattery, no hedging.

You will receive a code target together with its static-analysis metrics. Judge it across exactly five dimensions, each 0-100:
- complexity: cyclomatic cost, nesting depth, function length
- security: injection surfaces, hardcoded secrets, unsafe sinks
- maintainability: naming, comments, dead code, type discipline
- testCoverage: presence of sibling tests, assertion density, purity
- designPatterns: deliberate structure vs anti-patterns (god classes, global mutable state)

Score like a senior architect, not a lenient autopilot: only genuinely exemplary code earns 90+, shipped-but-rough code lands 65-80, anything with a critical red line stays under 45.

Output rules — absolute:
1. Respond with ONE JSON object and NOTHING else. No markdown fences, no commentary before or after.
2. Every dimension key must be present, integer 0-100.
3. "patterns" lists concretely evidenced design patterns and anti-patterns (kind: creational | structural | behavioral | anti).
4. "risks" lists business/operational hazards (severity: critical | major | minor | info), each with concrete file/line evidence when available.
5. "verdict" is ONE short paragraph, Chinese with an English tail — blunt, actionable, no platitudes.

JSON schema:
{
  "scores": {
    "complexity": number,
    "security": number,
    "maintainability": number,
    "testCoverage": number,
    "designPatterns": number,
    "scoreComments": { "complexity": string, "security": string, "maintainability": string, "testCoverage": string, "designPatterns": string }
  },
  "patterns": [{ "name": string, "kind": "creational" | "structural" | "behavioral" | "anti", "confidence": number, "evidence": string }],
  "risks": [{ "title": string, "severity": "critical" | "major" | "minor" | "info", "detail": string }],
  "verdict": string,
  "rank": "S" | "A" | "B" | "C" | "D" | "F"
}`

const MAX_CODE_CHARS = 24000
const MAX_FINDINGS_IN_PROMPT = 18

function summarizeMetrics(metrics: StaticMetrics): string {
  return [
    `files=${metrics.files} loc=${metrics.loc} sloc=${metrics.sloc}`,
    `commentRatio=${(metrics.commentRatio * 100).toFixed(1)}%`,
    `functions=${metrics.functions} classes=${metrics.classes}`,
    `maxCyclomatic=${metrics.maxCyclomatic} avgCyclomatic=${metrics.avgCyclomatic.toFixed(1)}`,
    `maxNesting=${metrics.maxNesting} longFunctions=${metrics.longFunctions}`,
    `testFiles=${metrics.testFiles} imports=${metrics.imports} exportedSymbols=${metrics.exportedSymbols}`,
  ].join(' · ')
}

function summarizeFindings(findings: Finding[]): string {
  const critical = findings.filter((finding) => finding.severity === 'critical').length
  const major = findings.filter((finding) => finding.severity === 'major').length
  const minor = findings.filter((finding) => finding.severity === 'minor').length
  const head = `RED CARDS (critical): ${critical} · YELLOW CARDS (major): ${major} · minor: ${minor}`
  const details = findings.slice(0, MAX_FINDINGS_IN_PROMPT).map((finding) => {
    const where = finding.file ? `${finding.file}:${finding.line ?? '?'}` : '(global)'
    return `  [${finding.severity.toUpperCase()}] ${finding.rule} @ ${where} — ${finding.message}`
  })
  return [head, ...details].join('\n')
}

/** Pick the most representative code excerpts (worst files first) within budget. */
function selectExcerpts(analysis: StaticAnalysis): string {
  const ranked = [...analysis.files]
    .sort((a, b) => (b.findings.length - a.findings.length) || (b.code.length - a.code.length))
  const excerpts: string[] = []
  let budget = MAX_CODE_CHARS
  for (const file of ranked) {
    if (budget <= 0) break
    const slice = file.code.slice(0, Math.min(budget, 4000))
    budget -= slice.length
    const header = `\n----- ${file.path} (${file.language}${file.parseError ? `, parseError: ${file.parseError}` : ''}) -----`
    excerpts.push(header + '\n' + slice.trimEnd() + (slice.length < file.code.length ? '\n…(truncated)' : ''))
  }
  return excerpts.join('\n') || '(no source available)'
}

export interface ArchitectPromptInput {
  analysis: StaticAnalysis
  target: string
  context?: string
}

export function buildArchitectUserPrompt(input: ArchitectPromptInput): string {
  const parts: string[] = []
  parts.push(`TARGET: ${input.target}`)
  parts.push(`STATIC METRICS: ${summarizeMetrics(input.analysis.metrics)}`)
  if (input.analysis.patterns.length > 0) {
    parts.push(
      'STATIC PATTERN HINTS:\n' +
        input.analysis.patterns
          .slice(0, 12)
          .map((pattern) => `  ${pattern.name} [${pattern.kind}] conf=${pattern.confidence} @ ${pattern.file}:${pattern.line}`)
          .join('\n'),
    )
  }
  parts.push(`STATIC FINDINGS:\n${summarizeFindings(input.analysis.findings)}`)
  if (input.context) parts.push(`BUSINESS CONTEXT: ${input.context}`)
  parts.push('CODE UNDER REVIEW:\n' + selectExcerpts(input.analysis))
  parts.push('Now deliver the JSON verdict. Remember: dimensions 0-100, evidence-based, one JSON object, no fences.')
  return parts.join('\n\n')
}
