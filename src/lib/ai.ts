import OpenAI from 'openai'

export function createClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  return new OpenAI({ apiKey })
}

export const MODELS = {
  review: 'gpt-4o-mini',
  agent: 'gpt-4o',
  depFix: 'gpt-4o-mini',
} as const

export const AGENT_MAX_TURNS = 20
