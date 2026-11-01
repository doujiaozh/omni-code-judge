/**
 * judge_cli — the geek execution entry.
 *
 * `node bin/judge.js src/index.ts` → a colored terminal verdict: grade badge,
 * five-dimension ASCII bar chart, red/yellow card warnings, plus optional
 * Markdown report dump (--output) and JSON output (--json).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judge } from '../judge.js'
import { renderMarkdownReport } from '../report/markdown.js'
import { DIMENSION_LABELS, SEVERITY_META } from '../types.js'
import type { JudgeOptions } from '../types.js'

const HELP = `Omni-Code-Judge — AI-powered code architecture & security evaluator

Usage:
  omni-judge <target> [options]        judge a file, directory, inline code or git diff
  omni-judge -  [options]              read source code from stdin

Options:
  --ai                    enable the LLM senior architect (needs AETHER_INKSTONE_API_KEY / OPENAI_API_KEY)
  --no-ai                 force pure static analysis (default)
  --diff                  treat the target as a unified git diff blob
  --model <id>            pin a model on the aether gateway
  --context <text>        extra business context for the architect
  --output <file.md>      also write the full Markdown battle report
  --json                  emit the result as machine-readable JSON
  --no-color              strip ANSI colors
  --cwd <dir>             working directory for sibling test discovery
  -h, --help              show this help
  -v, --version           show version

Examples:
  omni-judge src/index.ts
  omni-judge ./src --ai --output report.md
  git diff HEAD~1 | omni-judge - --diff
  omni-judge "const x: any = eval(input)" --ai
`

interface CliArgs {
  target?: string
  ai: boolean
  diff: boolean
  model?: string
  context?: string
  output?: string
  json: boolean
  color: boolean
  cwd?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { ai: false, diff: false, json: false, color: true }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--ai':
        args.ai = true
        break
      case '--no-ai':
        args.ai = false
        break
      case '--diff':
        args.diff = true
        break
      case '--json':
        args.json = true
        break
      case '--no-color':
        args.color = false
        break
      case '--model':
      case '--context':
      case '--output':
      case '--cwd':
      case '-o': {
        const value = argv[i + 1]
        if (!value || value.startsWith('--')) {
          console.error(`error: ${arg} requires a value`)
          process.exit(2)
        }
        i++
        if (arg === '--model') args.model = value
        if (arg === '--context') args.context = value
        if (arg === '--output' || arg === '-o') args.output = value
        if (arg === '--cwd') args.cwd = value
        break
      }
      case '-h':
      case '--help':
        console.log(HELP)
        process.exit(0)
      case '-v':
      case '--version':
        console.log(`omni-code-judge v${readVersion()}`)
        process.exit(0)
      default:
        if (arg.startsWith('--')) {
          console.error(`error: unknown option ${arg}`)
          process.exit(2)
        }
        positional.push(arg)
    }
  }
  if (positional.length > 1) {
    console.error(`error: expected exactly one target, got ${positional.length}`)
    process.exit(2)
  }
  args.target = positional[0]
  return args
}

function readVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url)
    const pkg = JSON.parse(readFileSync(resolve(here, '../../../package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/* ------------------------------------------------------------------ *
 * ANSI coloring (disabled when --no-color or when stdout is not a TTY)
 * ------------------------------------------------------------------ */

let useColor = true
function c(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text
}
const bold = (text: string) => c('1', text)
const dim = (text: string) => c('2', text)
const cyan = (text: string) => c('36', text)
const red = (text: string) => c('31', text)
const green = (text: string) => c('32', text)
const yellow = (text: string) => c('33', text)

function scoreColor(score: number): (text: string) => string {
  if (score >= 85) return green
  if (score >= 70) return cyan
  if (score >= 60) return yellow
  return red
}

function scoreBar(score: number, width = 28): string {
  const filled = Math.round((score / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

function readStdin(): Promise<string> {
  return new Promise((resolveStdin, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolveStdin(data))
    process.stdin.on('error', reject)
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.target === undefined) {
    console.error('error: missing target — pass a file, directory, diff or `-` for stdin')
    console.error(HELP)
    process.exit(2)
  }

  useColor = args.color && process.stdout.isTTY === true

  let target = args.target
  if (target === '-') {
    target = await readStdin()
  }

  const options: JudgeOptions = {
    ai: args.ai,
    diff: args.diff,
    ...(args.model ? { model: args.model } : {}),
    ...(args.context ? { context: args.context } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  }

  const result = await judge(target, options)

  if (args.json) {
    useColor = false
    process.stdout.write(`${JSON.stringify(result, (key, value) => (key === 'ast' ? undefined : value), 2)}\n`)
    return
  }

  const colorFor = scoreColor(result.total)
  const lines: string[] = []
  lines.push('')
  lines.push(cyan(bold('  ⚖️  Omni-Code-Judge — AI 代码架构审查')))
  lines.push(dim('      在 AI 时代，代码不仅要能跑，还要经得起资深架构师的审视。'))
  lines.push('')
  lines.push(`  ${bold('目标 Target')}    ${target.length > 60 ? `${target.slice(0, 57)}...` : target}`)
  lines.push(`  ${bold('评级 Grade')}     ${colorFor(bold(`【 ${result.grade} 】`))}  总分 ${colorFor(bold(String(result.total)))} / 100`)
  lines.push(`  ${bold('红黄牌')}        ${red(bold(`🔴 × ${result.redCards}`))}  ${yellow(bold(`🟠 × ${result.yellowCards}`))}`)
  if (result.ai) {
    const aiLabel = result.ai.mode === 'live' ? green('live · 云端架构师') : yellow('fallback · 离线兜底')
    lines.push(`  ${bold('AI 架构师')}     ${aiLabel}  ${dim(`(${result.ai.model})`)}`)
  } else {
    lines.push(`  ${bold('AI 架构师')}     ${dim('未启用（--ai 开启）')}`)
  }
  lines.push('')
  lines.push(`  ${bold('五维评级 · Five Dimensions')}`)
  for (const dimension of result.dimensions) {
    const label = DIMENSION_LABELS[dimension.dimension].split(' ')[0]
    const bar = scoreColor(dimension.score)(scoreBar(dimension.score))
    const aiPart = dimension.aiScore !== undefined ? ` AI:${scoreColor(dimension.aiScore)(String(dimension.aiScore))}` : ''
    lines.push(`    ${label.padEnd(6, '　')} ${bar} ${scoreColor(dimension.score)(String(dimension.score).padStart(3))}${aiPart}`)
  }
  lines.push('')
  if (result.redCards > 0 || result.yellowCards > 0) {
    lines.push(`  ${bold('红黄牌警告 · Cards')}`)
    for (const finding of result.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major').slice(0, 8)) {
      const emoji = SEVERITY_META[finding.severity].emoji
      const location = finding.file ? `${finding.file}:${finding.line ?? '?'}` : '—'
      lines.push(`    ${emoji} ${bold(finding.rule)} ${dim(`@ ${location}`)} — ${finding.message}`)
    }
    if (result.redCards + result.yellowCards > 8) {
      lines.push(dim(`    ... 共 ${result.redCards + result.yellowCards} 张牌，完整明细见报告`))
    }
    lines.push('')
  }
  lines.push(`  ${bold('架构师判词 · Verdict')}`)
  for (const paragraph of result.verdictText.split('\n')) {
    lines.push(`    ${paragraph}`)
  }
  lines.push('')
  lines.push(dim(`  审查耗时 ${result.durationMs}ms · 静态规则 CPL/SEC/MNT/TST/PAT · ${result.files.length} 个文件 · ${result.metrics.loc} 行`))
  lines.push('')

  process.stdout.write(`${lines.join('\n')}\n`)

  if (args.output) {
    const { writeFileSync } = await import('node:fs')
    const reportPath = resolve(args.cwd ?? process.cwd(), args.output)
    writeFileSync(reportPath, renderMarkdownReport(result), 'utf8')
    process.stdout.write(green(`  ✓ 战报已生成: ${reportPath}\n\n`))
  }

  // Non-zero exit for really bad code, so CI can gate on it.
  process.exitCode = result.redCards > 0 ? 1 : 0
}

main().catch((error) => {
  const redText = !process.argv.includes('--no-color') ? (text: string) => `\x1b[31m${text}\x1b[0m` : (text: string) => text
  console.error(`${redText('✖ judge failed')}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
