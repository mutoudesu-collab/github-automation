import Anthropic from '@anthropic-ai/sdk'

export function createClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  return new Anthropic({ apiKey })
}

export const MODELS = {
  review: 'claude-haiku-4-5-20251001',
  agent: 'claude-sonnet-4-6',
  depFix: 'claude-haiku-4-5-20251001',
} as const

export const AGENT_MAX_TURNS = 20
