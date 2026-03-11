import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process'
import OpenAI from 'openai'
import { createClient, MODELS, AGENT_MAX_TURNS } from '../lib/anthropic'
import {
  createOctokit,
  getRepoCreds,
  getDefaultBranch,
  getLatestCommitSha,
  createBranch,
  pushFilesToBranch,
  createPullRequest,
} from '../lib/github'
import { buildDepFixPrompt } from '../lib/prompts'
import * as fs from 'fs'
import * as path from 'path'

const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd()
const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = { cwd: WORKSPACE, encoding: 'utf-8' }

interface FileChange {
  path: string
  content: string
}

interface AgentState {
  messages: OpenAI.ChatCompletionMessageParam[]
  changes: FileChange[]
  summary: string
  turns: number
  done: boolean
}

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repository root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or update a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repository root' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Signal that fixes are complete',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of fixes applied (in Japanese)' },
        },
        required: ['summary'],
      },
    },
  },
]

function executeTool(name: string, input: Record<string, string>, state: AgentState): string {
  switch (name) {
    case 'read_file': {
      const fullPath = path.join(WORKSPACE, input.path)
      if (!fs.existsSync(fullPath)) return `Error: File not found: ${input.path}`
      return fs.readFileSync(fullPath, 'utf-8')
    }

    case 'write_file': {
      const fullPath = path.join(WORKSPACE, input.path)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, input.content)
      const existing = state.changes.findIndex(f => f.path === input.path)
      if (existing >= 0) {
        state.changes[existing].content = input.content
      } else {
        state.changes.push({ path: input.path, content: input.content })
      }
      return `Written: ${input.path}`
    }

    case 'finish': {
      state.summary = input.summary
      state.done = true
      return 'Fixes marked as complete'
    }

    default:
      return `Error: Unknown tool: ${name}`
  }
}

async function runFixLoop(client: OpenAI, prompt: string, state: AgentState): Promise<void> {
  state.messages.push({ role: 'user', content: prompt })

  while (!state.done && state.turns < AGENT_MAX_TURNS) {
    state.turns++
    console.log(`Fix turn ${state.turns}/${AGENT_MAX_TURNS}`)

    const response = await client.chat.completions.create({
      model: MODELS.depFix,
      max_tokens: 8192,
      tools,
      messages: state.messages,
    })

    const message = response.choices[0].message
    state.messages.push(message)

    if (response.choices[0].finish_reason === 'stop') break
    if (response.choices[0].finish_reason !== 'tool_calls') break

    for (const toolCall of message.tool_calls ?? []) {
      const input = JSON.parse(toolCall.function.arguments) as Record<string, string>
      const result = executeTool(toolCall.function.name, input, state)
      state.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      })
      if (state.done) break
    }
  }

  if (state.turns >= AGENT_MAX_TURNS && !state.done) {
    console.warn(`Fix agent reached max turns (${AGENT_MAX_TURNS})`)
    state.summary = `依存関係の修正を試みましたが、最大ターン数（${AGENT_MAX_TURNS}）に達したため完了できませんでした。手動確認が必要です。`
  }
}

function run(cmd: string): { output: string; success: boolean } {
  try {
    const output = execSync(cmd, { ...EXEC_OPTS, stdio: 'pipe' })
    return { output, success: true }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string }
    return { output: `${err.stdout ?? ''}\n${err.stderr ?? ''}`, success: false }
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10)
  const branchName = `dep-upgrade/${today}`

  const octokit = createOctokit()
  const creds = getRepoCreds()

  const packageJsonBefore = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf-8')

  console.log('Running npm update...')
  execSync('npm update', EXEC_OPTS)

  const packageJsonAfter = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf-8')
  const packageLockAfter = fs.existsSync(path.join(WORKSPACE, 'package-lock.json'))
    ? fs.readFileSync(path.join(WORKSPACE, 'package-lock.json'), 'utf-8')
    : null

  if (packageJsonBefore === packageJsonAfter) {
    console.log('No dependency updates available')
    return
  }

  console.log('Running tests...')
  const testResult = run('npm test')

  let fixSummary = ''
  let agentTurns = 0
  const changedFiles: FileChange[] = [
    { path: 'package.json', content: packageJsonAfter },
    ...(packageLockAfter ? [{ path: 'package-lock.json', content: packageLockAfter }] : []),
  ]

  if (!testResult.success) {
    console.log('Tests failed, running fix agent...')

    const packageDiff = execSync(`diff <(echo '${packageJsonBefore}') package.json || true`, {
      ...EXEC_OPTS,
      shell: '/bin/bash',
    })

    const client = createClient()
    const state: AgentState = { messages: [], changes: [], summary: '', turns: 0, done: false }

    await runFixLoop(client, buildDepFixPrompt(testResult.output, packageDiff), state)

    fixSummary = state.summary
    agentTurns = state.turns
    changedFiles.push(...state.changes)

    const retestResult = run('npm test')
    if (!retestResult.success) {
      fixSummary += '\n\n⚠️ 修正後もテストが失敗しています。手動での確認が必要です。'
    }
  }

  const defaultBranch = await getDefaultBranch(octokit, creds)
  const baseSha = await getLatestCommitSha(octokit, creds, defaultBranch)

  try {
    await createBranch(octokit, creds, branchName, baseSha)
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('Reference already exists')) {
      console.log(`Branch ${branchName} already exists, skipping`)
      return
    }
    throw e
  }

  await pushFilesToBranch(
    octokit, creds, branchName,
    [...new Map(changedFiles.map(f => [f.path, f])).values()],
    `chore: upgrade dependencies ${today}`
  )

  const prBody = [
    '## 依存関係アップグレード',
    '',
    '`npm update` を実行して依存関係を更新しました。',
    '',
    testResult.success
      ? '✅ テストはすべてパスしています。'
      : fixSummary
        ? `### AIによる修正\n\n${fixSummary}\n\n*${agentTurns}ターン使用*`
        : '⚠️ テストが失敗しています。手動確認が必要です。',
    '',
    '---',
    '*このPRはAIによって自動生成されました*',
  ].join('\n')

  const prUrl = await createPullRequest(octokit, creds, {
    title: `chore: dependency upgrade ${today}`,
    body: prBody,
    head: branchName,
    base: defaultBranch,
  })

  console.log(`PR created: ${prUrl}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
