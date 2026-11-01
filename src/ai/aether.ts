/**
 * judge_ai — aether LLM gateway access.
 *
 * Primary path: the real `aether-llm` package (OpenAI-compatible client with
 * RPM pacing, 429 exponential backoff and a fast/strong model router), linked
 * from the local aether monorepo.
 *
 * Fallback: if the import fails (package pruned, vendored elsewhere), an
 * ultra-light client implementing the same `chat()` contract against the same
 * environment variables. Pure fetch — zero native modules, Win7 friendly.
 */

import type { ChatMessage } from '../types.js'

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  /** Routing hint: 'complex' work targets the strong tier. */
  complexity?: 'trivial' | 'standard' | 'complex'
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
  routedModel: string
}

export interface LLMGateway {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>
}

export const DEFAULT_BASE_URL = 'https://api.inkstone.ilight.io/v1'
export const FLEET = { fast: 'atriadawn', strong: 'deepseek-v4.1' } as const

export function resolveApiKey(): string | undefined {
  return process.env.AETHER_INKSTONE_API_KEY ?? process.env.OPENAI_API_KEY
}

export function resolveModelHint(complexity?: ChatOptions['complexity']): string {
  if (process.env.AETHER_LLM_MODEL) return process.env.AETHER_LLM_MODEL
  return complexity === 'complex' ? FLEET.strong : FLEET.fast
}

/**
 * Minimal OpenAI-compatible client — same chat() contract as aether-llm's
 * LLMClient, used only when the aether-llm package itself is unavailable.
 */
class MinimalOpenAIClient implements LLMGateway {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const model = options.model ?? resolveModelHint(options.complexity)
    const payload = {
      model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: options.temperature ?? 0.2,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    }

    const attempt = async (retriesLeft: number): Promise<ChatResult> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120000)
      if (options.signal) options.signal.addEventListener('abort', () => controller.abort())
      try {
        const response = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if ((response.status === 429 || response.status >= 500) && retriesLeft > 0) {
          await new Promise((resolve) => setTimeout(resolve, 800 * (4 - retriesLeft)))
          return attempt(retriesLeft - 1)
        }
        if (!response.ok) {
          throw new Error(`gateway ${response.status}: ${await response.text().catch(() => 'unreadable body')}`)
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>
        }
        const content = data.choices?.[0]?.message?.content
        if (!content) throw new Error('gateway returned an empty completion')
        return { content, routedModel: model }
      } finally {
        clearTimeout(timeout)
      }
    }

    return attempt(3)
  }
}

export interface ResolvedGateway {
  gateway: LLMGateway
  origin: 'aether-llm' | 'builtin-fallback'
}

/**
 * Resolve the LLM gateway. Reuses aether-llm when importable; otherwise falls
 * back to the built-in minimal client over the identical env conventions.
 */
export async function resolveGateway(): Promise<ResolvedGateway> {
  const apiKey = resolveApiKey()
  if (!apiKey) throw new Error('no api key configured (AETHER_INKSTONE_API_KEY or OPENAI_API_KEY)')
  try {
    const aether = await import('aether-llm')
    const client = aether.createEnvClient({ apiKey })
    return { gateway: client as unknown as LLMGateway, origin: 'aether-llm' }
  } catch {
    const baseURL = process.env.AETHER_LLM_BASE_URL ?? DEFAULT_BASE_URL
    return { gateway: new MinimalOpenAIClient(baseURL, apiKey), origin: 'builtin-fallback' }
  }
}
