import { execSync } from 'child_process'
import { createClient, MODELS } from '../lib/anthropic'
import { createOctokit, getRepoCreds, postPRReview } from '../lib/github'
import { buildReviewPrompt } from '../lib/prompts'

const DIFF_SIZE_LIMIT = 100_000

interface ReviewIssue {
  severity: 'critical' | 'warning' | 'suggestion'
  file: string
  description: string
}

interface ReviewResult {
  summary: string
  issues: ReviewIssue[]
}

async function main() {
  const prNumber = parseInt(process.env.PR_NUMBER ?? '')
  const baseSha = process.env.BASE_SHA
  const headSha = process.env.HEAD_SHA
  const prTitle = process.env.PR_TITLE ?? ''
  const prBody = process.env.PR_BODY ?? ''

  if (!prNumber || !baseSha || !headSha) {
    throw new Error('PR_NUMBER, BASE_SHA, HEAD_SHA are required')
  }

  const diff = execSync(`git diff ${baseSha}...${headSha}`, { encoding: 'utf-8' })

  if (diff.length > DIFF_SIZE_LIMIT) {
    console.log(`Diff too large (${diff.length} bytes), skipping review`)
    const octokit = createOctokit()
    const creds = getRepoCreds()
    await postPRReview(
      octokit,
      creds,
      prNumber,
      `⚠️ このPRのdiffが大きすぎるため（${Math.round(diff.length / 1024)}KB）、自動レビューをスキップしました。`
    )
    return
  }

  const client = createClient()
  const response = await client.chat.completions.create({
    model: MODELS.review,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: buildReviewPrompt(diff, prTitle, prBody) }],
  })

  const text = response.choices[0].message.content ?? ''
  let result: ReviewResult

  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`Failed to parse GPT response as JSON:\n${text}`)
  }

  const body = formatReviewBody(result)
  const octokit = createOctokit()
  const creds = getRepoCreds()
  await postPRReview(octokit, creds, prNumber, body)

  console.log(`Review posted: ${result.issues.length} issue(s) found`)
}

function formatReviewBody(result: ReviewResult): string {
  const severityEmoji = {
    critical: '🔴',
    warning: '🟡',
    suggestion: '🔵',
  }

  const lines: string[] = [
    '## 🤖 AI Code Review',
    '',
    result.summary,
  ]

  if (result.issues.length === 0) {
    lines.push('', '✅ 問題は見つかりませんでした。')
    return lines.join('\n')
  }

  lines.push('', '---', '')

  for (const issue of result.issues) {
    const emoji = severityEmoji[issue.severity]
    lines.push(`### ${emoji} ${issue.severity.toUpperCase()}`)
    lines.push(`**ファイル:** \`${issue.file}\``)
    lines.push('')
    lines.push(issue.description)
    lines.push('')
  }

  return lines.join('\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

// TODO: remove this
function unusedHelper(data: any) {
  var password = "admin123"
  eval(data)
  return null
}
