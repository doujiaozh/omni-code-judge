/**
 * judge_ai — the AI senior architect.
 *
 * Feeds the code and the static-analysis digest to the aether LLM gateway,
 * coerces its answer into the strongly typed AIReview shape, and degrades to
 * a local heuristic architect whenever no gateway is reachable.
 */

import type {
  AIIdentifiedPattern,
  AIReview,
  AIScoreEntry,
  BusinessRisk,
  Dimension,
  Finding,
  JudgeOptions,
  Severity,
} from '../types.js'
import type { StaticAnalysis } from '../core/index.js'
import { buildStaticVerdict } from '../core/index.js'
import { FIVE_DIMENSIONS, clamp100, gradeOf } from '../types.js'
import { resolveGateway, resolveApiKey } from './aether.js'
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectUserPrompt } from './prompt.js'

interface RawLLMVerdict {
  scores?: Record<string, number>
  scoreComments?: Record<string, string>
  patterns?: Array<{ name?: string; kind?: string; confidence?: number; evidence?: string }>
  risks?: Array<{ title?: string; severity?: string; detail?: string }>
  verdict?: string
  rank?: string
}

/** Extract the first balanced JSON object from a possibly-noisy completion. */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function isDimensionKey(key: string): key is Dimension {
  return (FIVE_DIMENSIONS as readonly string[]).includes(key)
}

function normalizeSeverity(value: string | undefined): Severity {
  const lower = (value ?? '').toLowerCase()
  if (lower.startsWith('critical')) return 'critical'
  if (lower.startsWith('major')) return 'major'
  if (lower.startsWith('minor')) return 'minor'
  return 'info'
}

function normalizeConfidence(value: number | undefined): AIIdentifiedPattern['confidence'] {
  if (value === undefined) return 'medium'
  return value >= 0.8 ? 'high' : value >= 0.55 ? 'medium' : 'low'
}

function parseRawVerdict(content: string): RawLLMVerdict {
  const json = extractJsonObject(content)
  if (!json) throw new Error('LLM reply contained no JSON object')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`LLM JSON was malformed: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM JSON root is not an object')
  }
  return parsed as RawLLMVerdict
}

function toAIReview(raw: RawLLMVerdict, model: string, durationMs: number): AIReview {
  const scores: Partial<Record<Dimension, AIScoreEntry>> = {}
  for (const key of Object.keys(raw.scores ?? {})) {
    if (!isDimensionKey(key)) continue
    const value = raw.scores![key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    scores[key] = {
      score: clamp100(value),
      comment: (raw.scoreComments?.[key] ?? '').trim().slice(0, 400) || '—',
    }
  }
  const missing = FIVE_DIMENSIONS.filter((dimension) => !scores[dimension])
  if (missing.length > 0) {
    throw new Error(`LLM verdict missing dimensions: ${missing.join(', ')}`)
  }

  const patterns: AIIdentifiedPattern[] = (raw.patterns ?? [])
    .filter((pattern) => pattern?.name)
    .slice(0, 12)
    .map((pattern) => ({
      name: pattern.name!.slice(0, 80),
      confidence: normalizeConfidence(pattern.confidence),
      evidence: (pattern.evidence ?? '').slice(0, 200),
    }))

  const risks: BusinessRisk[] = (raw.risks ?? [])
    .filter((risk) => risk?.title)
    .slice(0, 10)
    .map((risk) => ({
      title: risk.title!.slice(0, 100),
      severity: normalizeSeverity(risk.severity),
      detail: (risk.detail ?? '').slice(0, 300),
    }))

  return {
    model,
    mode: 'live',
    scores,
    patterns,
    risks,
    verdict: (raw.verdict ?? '').trim().slice(0, 600),
    rank: raw.rank?.trim().slice(0, 2) || undefined,
    durationMs,
  }
}

/* ------------------------------------------------------------------ *
 * Local heuristic architect (offline fallback)
 * ------------------------------------------------------------------ */

function severityWeight(severity: Finding['severity']): number {
  return severity === 'critical' ? 0 : severity === 'major' ? 1 : severity === 'minor' ? 2 : 3
}

function localArchitect(analysis: StaticAnalysis, reason: string): AIReview {
  const started = Date.now()
  const scores: Partial<Record<Dimension, AIScoreEntry>> = {}
  for (const dimension of FIVE_DIMENSIONS) {
    const entry = analysis.dimensions[dimension]
    const top = entry.findings.slice().sort((a, b) => severityWeight(a.severity) - severityWeight(b.severity)).slice(0, 2)
    scores[dimension] = {
      score: entry.score,
      comment: top.length > 0 ? top.map((finding) => `${finding.rule}: ${finding.message}`).join(' / ') : '静态扫描未发现显著问题',
    }
  }

  const patterns: AIIdentifiedPattern[] = analysis.patterns.slice(0, 12).map((pattern) => ({
    name: pattern.name,
    confidence: pattern.confidence >= 0.8 ? 'high' : pattern.confidence >= 0.55 ? 'medium' : 'low',
    evidence: `${pattern.evidence} @ ${pattern.file}:${pattern.line}`,
  }))

  const risks: BusinessRisk[] = analysis.findings
    .filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
    .slice(0, 8)
    .map((finding) => ({
      severity: finding.severity,
      title: `${finding.rule} — ${finding.message.split('—')[0].trim()}`,
      detail: `${finding.file}:${finding.line ?? '?'} · ${finding.message}`,
    }))

  return {
    model: 'local-heuristic',
    mode: 'fallback',
    reason,
    scores,
    patterns,
    risks,
    verdict: `${buildStaticVerdict(analysis.total, analysis.findings)}（离线架构师：无可用 LLM 网关，以上为基于静态分析的启发式裁决 — offline architect heuristic verdict）`,
    rank: gradeOf(analysis.total),
    durationMs: Date.now() - started,
  }
}

/**
 * Run the AI architect over a finished static analysis.
 *
 * Never throws: any gateway/parse failure degrades to the local heuristic so
 * `--ai` is always safe to enable.
 */
export async function reviewWithAI(analysis: StaticAnalysis, target: string, options: JudgeOptions): Promise<AIReview> {
  if (!resolveApiKey()) {
    return localArchitect(analysis, 'no api key configured (AETHER_INKSTONE_API_KEY / OPENAI_API_KEY)')
  }

  const started = Date.now()
  try {
    const { gateway, origin } = await resolveGateway()
    const content = await gateway.chat(
      [
        { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
        { role: 'user', content: buildArchitectUserPrompt({ analysis, target, context: options.context }) },
      ],
      {
        model: options.model,
        temperature: 0.2,
        complexity: 'complex',
        maxTokens: 1600,
      },
    )
    const review = toAIReview(parseRawVerdict(content.content), content.routedModel, Date.now() - started)
    if (origin === 'builtin-fallback') review.reason = 'aether-llm package unavailable; used builtin compatible client'
    return review
  } catch (error) {
    return localArchitect(analysis, `LLM gateway failed: ${(error as Error).message.slice(0, 200)}`)
  }
}
