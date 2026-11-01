/**
 * judge_report — the battle report.
 *
 * Combines static analysis and the AI architect's verdict into one hardcore
 * Markdown document: grade badge, five-dimension table, a pure-CSS radar
 * chart, red/yellow card warnings, pattern detections and full finding
 * detail. The radar block is inline HTML/CSS — no SVG, no JS — so it renders
 * wherever inline styles are honored (VS Code, Typora, browsers).
 */

import {
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  SEVERITY_META,
  type Finding,
  type JudgeResult,
  type Severity,
} from '../types.js'
import { renderRadarHtml } from './radar.js'

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function findingLocation(finding: Finding): string {
  return finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '—'
}

/** Red/yellow card section: criticals get red cards, majors get yellow. */
function renderCards(findings: Finding[]): string {
  const criticals = findings.filter((finding) => finding.severity === 'critical')
  const majors = findings.filter((finding) => finding.severity === 'major')

  if (criticals.length === 0 && majors.length === 0) {
    return '## 🟢 红黄牌警告 · Red & Yellow Cards\n\n> **零红牌零黄牌 — no critical or major violations.** 这段代码没有触碰任何架构红线。\n'
  }

  const lines = ['## 🟥🟨 红黄牌警告 · Red & Yellow Cards', '']
  if (criticals.length > 0) {
    lines.push(`> 🔴 **${criticals.length} 张红牌（RED CARD · critical）—— 触碰架构红线，必须立即修复：**`)
    lines.push('')
    lines.push('| 红牌 | 规则 | 位置 | 问题 |')
    lines.push('| :---: | :--- | :--- | :--- |')
    for (const finding of criticals) {
      lines.push(`| 🔴 | \`${finding.rule}\` | \`${findingLocation(finding)}\` | ${escapeMarkdown(finding.message)} |`)
    }
    lines.push('')
  }
  if (majors.length > 0) {
    lines.push(`> 🟠 **${majors.length} 张黄牌（YELLOW CARD · major）—— 高风险技术债，本迭代内必须处理：**`)
    lines.push('')
    lines.push('| 黄牌 | 规则 | 位置 | 问题 |')
    lines.push('| :---: | :--- | :--- | :--- |')
    for (const finding of majors.slice(0, 20)) {
      lines.push(`| 🟠 | \`${finding.rule}\` | \`${findingLocation(finding)}\` | ${escapeMarkdown(finding.message)} |`)
    }
    if (majors.length > 20) lines.push(`| ... | | | _另有 ${majors.length - 20} 张黄牌，见下方完整明细_ |`)
    lines.push('')
  }
  return lines.join('\n')
}

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function renderDimensionTable(result: JudgeResult): string {
  const lines = [
    '## 📊 五维评级 · Five-Dimension Scores',
    '',
    '| 维度 Dimension | 权重 | 静态分 | AI 架构师分 | AI 评语 |',
    '| :--- | :---: | :---: | :---: | :--- |',
  ]
  for (const dimension of result.dimensions) {
    const label = DIMENSION_LABELS[dimension.dimension]
    const weightPct = `${Math.round(DIMENSION_WEIGHTS[dimension.dimension] * 100)}%`
    const aiScore = dimension.aiScore !== undefined ? `**${dimension.aiScore}**` : '—'
    const aiComment = dimension.aiComment ? escapeMarkdown(dimension.aiComment) : '_未启用 AI_'
    lines.push(`| ${label} | ${weightPct} | ${dimension.score} | ${aiScore} | ${aiComment} |`)
  }
  lines.push('')
  const blendedNote = result.ai?.mode === 'live'
    ? `> 总分 = 静态分析 70% + AI 架构师 30% 加权融合（AI 模型 \`${result.ai.model}\`）`
    : result.ai?.mode === 'fallback'
      ? `> 总分 = 纯静态加权（AI 架构师离线：\`${result.ai.reason}\`）`
      : '> 总分 = 纯静态加权（未启用 AI 架构师）'
  lines.push(blendedNote, '')
  return lines.join('\n')
}

function renderMetricsTable(result: JudgeResult): string {
  const m = result.metrics
  const rows: Array<[string, string | number]> = [
    ['文件数 Files', m.files],
    ['总行数 LOC', m.loc],
    ['源代码行 SLOC', m.sloc],
    ['注释行 / 比率', `${m.commentLines} (${(m.commentRatio * 100).toFixed(1)}%)`],
    ['函数 Functions', m.functions],
    ['类 Classes', m.classes],
    ['导入 Imports', m.imports >= 20 ? `${m.imports} ⚠️` : `${m.imports}`],
    ['导出符号 Exports', m.exportedSymbols],
    ['最大圈复杂度 Max Cyclomatic', m.maxCyclomatic],
    ['平均圈复杂度 Avg Cyclomatic', m.avgCyclomatic.toFixed(1)],
    ['最大嵌套深度 Max Nesting', m.maxNesting],
    ['超长函数(>50行) Long Functions', m.longFunctions],
    ['测试文件 Test Files', m.testFiles],
  ]
  const lines = ['## 🧮 静态指标仪表盘 · Static Metrics', '', '| 指标 | 数值 |', '| :--- | :---: |']
  for (const [key, value] of rows) lines.push(`| ${key} | ${value} |`)
  return [...lines, ''].join('\n')
}

function renderPatterns(result: JudgeResult): string {
  if (result.patterns.length === 0) {
    return '## 🧩 设计模式检出 · Design Patterns\n\n> 未检出任何明确设计模式，也未发现典型反模式 —— 可能是朴素脚本代码。\n'
  }
  const lines = ['## 🧩 设计模式检出 · Design Patterns', '', '| 模式 | 类型 | 置信度 | 证据 |', '| :--- | :---: | :---: | :--- |']
  const sorted = [...result.patterns].sort((a, b) => (a.kind === 'anti' ? 0 : 1) - (b.kind === 'anti' ? 0 : 1) || b.confidence - a.confidence)
  for (const pattern of sorted.slice(0, 20)) {
    const kindEmoji = pattern.kind === 'anti' ? '🚫 anti' : pattern.kind === 'di' ? '🔗 DI' : `✨ ${pattern.kind}`
    lines.push(`| ${pattern.name} | ${kindEmoji} | ${(pattern.confidence * 100).toFixed(0)}% | \`${pattern.file}:${pattern.line ?? '?'}\` ${escapeMarkdown(pattern.evidence)} |`)
  }
  if (sorted.length > 20) lines.push(`| ... | | | _另有 ${sorted.length - 20} 个模式检出_ |`)
  return [...lines, ''].join('\n')
}

function renderAIRisks(result: JudgeResult): string {
  const ai = result.ai
  if (!ai || ai.risks.length === 0) return ''
  const lines = ['## ⚡ AI 架构师 · 业务风险清单 · Business Risks', '']
  if (ai.mode === 'fallback') lines.push(`> _离线架构师（${ai.reason}）：以下风险由静态发现启发式推导。_`, '')
  for (const risk of ai.risks) {
    lines.push(`- **${SEVERITY_META[risk.severity].emoji} ${escapeMarkdown(risk.title)}** — ${escapeMarkdown(risk.detail)}`)
  }
  return [...lines, ''].join('\n')
}

function renderFindingDetail(result: JudgeResult): string {
  if (result.findings.length === 0) {
    return '## 🔍 问题明细 · Findings\n\n> 零发现 —— 静态扫描没有找到任何可报告的问题。\n'
  }
  const lines = ['## 🔍 问题明细 · Findings (按严重度排序)', '']
  const grouped: Record<Severity, Finding[]> = { critical: [], major: [], minor: [], info: [] }
  for (const finding of result.findings) grouped[finding.severity].push(finding)

  for (const severity of ['critical', 'major', 'minor', 'info'] as Severity[]) {
    const group = grouped[severity]
    if (group.length === 0) continue
    const meta = SEVERITY_META[severity]
    lines.push(`### ${meta.emoji} ${meta.card} × ${group.length}`)
    lines.push('')
    lines.push('| 规则 | 维度 | 位置 | 问题 |')
    lines.push('| :--- | :--- | :--- | :--- |')
    for (const finding of group.slice(0, 40)) {
      const label = DIMENSION_LABELS[finding.dimension].split(' ')[0]
      lines.push(`| \`${finding.rule}\` | ${label} | \`${findingLocation(finding)}\` | ${escapeMarkdown(finding.message)} |`)
    }
    if (group.length > 40) lines.push(`| | | | _另有 ${group.length - 40} 条 ${severity} 级发现_ |`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderFileList(result: JudgeResult): string {
  const lines = ['## 📁 受审文件清单 · Files Under Review', '']
  for (const file of result.files) {
    const flag = file.parseError ? ` ⚠️ 解析失败: ${file.parseError}` : ''
    const fnCount = file.functions.length
    lines.push(`- \`${file.path}\` — ${file.language.toUpperCase()} · ${file.code.split('\n').length} 行 · ${fnCount} 函数${flag}`)
  }
  return [...lines, ''].join('\n')
}

export interface ReportOptions {
  /** Skip the pure-CSS radar block (for terminals that only want tables). */
  noRadar?: boolean
}

/** Render the full hardcore Markdown battle report. */
export function renderMarkdownReport(result: JudgeResult, options: ReportOptions = {}): string {
  const ai = result.ai
  const radarBlock = options.noRadar ? '' : `${renderRadarHtml(result.dimensions, 300)}\n\n`

  return `# ⚖️ Omni-Code-Judge 架构审查战报 · Architecture Review Report

> **Omni-Code-Judge：在 AI 时代，代码不仅要能跑，还要经得起资深架构师的审视。**

| 审查目标 Target | \`${result.target}\` |
| :--- | :--- |
| 生成时间 | ${formatTimestamp(result.createdAt)} |
| 综合评级 Grade | # ${result.grade} 级 — 总分 **${result.total}** / 100 |
| 红黄牌 | 🔴 红牌 × ${result.redCards} · 🟠 黄牌 × ${result.yellowCards} |
| AI 架构师 | ${ai ? `\`${ai.model}\`（${ai.mode === 'live' ? '云端在线' : '离线兜底'}）` : '未启用'} |
| 审查耗时 | ${result.durationMs} ms |

---

## 🏛️ 架构师判词 · The Verdict

> ${escapeMarkdown(result.verdictText)}

---

${renderDimensionTable(result)}

${radarBlock}---

${renderCards(result.findings)}

---

${renderMetricsTable(result)}

---

${renderPatterns(result)}

---

${renderAIRisks(result)}${renderFindingDetail(result)}

---

${renderFileList(result)}

> Generated by **Omni-Code-Judge** — 纯 TypeScript AST 静态分析 + aether LLM 资深架构师评审。
> Static rules: CPL/SEC/MNT/TST/PAT · 双轨扫描（AST 优先，正则回退）。
`
}
