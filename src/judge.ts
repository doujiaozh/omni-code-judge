/**
 * Omni-Code-Judge — top-level orchestrator.
 *
 * Pipeline: static AST analysis (judge_core) → optional LLM architect
 * (judge_ai) → blended five-dimension verdict. This is the single entry point
 * both the CLI and any future web UI build on.
 */

import { buildStaticVerdict, runStaticAnalysis } from './core/index.js'
import { reviewWithAI } from './ai/judge.js'
import {
  DIMENSION_WEIGHTS,
  FIVE_DIMENSIONS,
  gradeOf,
  type DimensionScore,
  type JudgeOptions,
  type JudgeResult,
} from './types.js'

/** How much a live AI verdict moves the final score (static analysis keeps the rest). */
const AI_BLEND_RATIO = 0.3

function aiWeightedTotal(scores: JudgeResult['ai']): number {
  if (!scores) return 0
  let sum = 0
  let weight = 0
  for (const dimension of FIVE_DIMENSIONS) {
    const entry = scores.scores[dimension]
    if (entry) {
      sum += entry.score * DIMENSION_WEIGHTS[dimension]
      weight += DIMENSION_WEIGHTS[dimension]
    }
  }
  return weight > 0 ? sum / weight : 0
}

/**
 * Judge a code target end to end.
 *
 * @param target file path, directory, inline source, or a git diff blob
 * @param options judge options; `ai: true` enables the LLM architect
 */
export async function judge(target: string, options: JudgeOptions = {}): Promise<JudgeResult> {
  const started = Date.now()
  const analysis = runStaticAnalysis(target, options)
  const ai = options.ai ? await reviewWithAI(analysis, target, options) : undefined

  const dimensions: DimensionScore[] = FIVE_DIMENSIONS.map((dimension) => {
    const entry = analysis.dimensions[dimension]
    const aiEntry = ai?.scores[dimension]
    return {
      dimension,
      score: entry.score,
      weight: entry.weight,
      metrics: entry.metrics,
      findings: entry.findings,
      ...(aiEntry ? { aiScore: aiEntry.score, aiComment: aiEntry.comment } : {}),
    }
  })

  const staticTotal = analysis.total
  let total = staticTotal
  if (ai?.mode === 'live') {
    const blended = staticTotal * (1 - AI_BLEND_RATIO) + aiWeightedTotal(ai) * AI_BLEND_RATIO
    total = Math.round(blended)
  }

  const grade = gradeOf(total)
  const redCards = analysis.findings.filter((finding) => finding.severity === 'critical').length
  const yellowCards = analysis.findings.filter((finding) => finding.severity === 'major').length
  const verdictText = ai?.verdict?.trim() || buildStaticVerdict(total, analysis.findings)

  return {
    target,
    createdAt: new Date().toISOString(),
    files: analysis.files,
    metrics: analysis.metrics,
    patterns: analysis.patterns,
    dimensions,
    findings: analysis.findings,
    ...(ai ? { ai } : {}),
    total,
    grade,
    redCards,
    yellowCards,
    verdictText,
    durationMs: Date.now() - started,
  }
}

export { runStaticAnalysis, buildStaticVerdict } from './core/index.js'
export { reviewWithAI } from './ai/judge.js'
