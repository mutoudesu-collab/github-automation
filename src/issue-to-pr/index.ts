import { execSync } from 'child_process'
import Anthropic from '@anthropic-ai/sdk'
import { createClient, MODELS, AGENT_MAX_TURNS } from '../lib/anthropic'
import {
  createOctokit,
  getRepoCreds,
  postIssueComment,
  getDefaultBranch,
  getLatestCommitSha,
  createBranch,
  pushFilesToBranch,
  createPullRequest,
} from '../lib/github'
import { buildImplementationPrompt } from '../lib/prompts'
import * as fs from 'fs'
import * as path from 'path'

const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd()

interface FileChange {
  path: string
  content: string
}

interface AgentState {
  messages: Anthropic.MessageParam[]
  changes: FileChange[]
  summary: string
  turns: number
  done: boolean
}

const tools: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to repository root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or update a file in the repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to repository root' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    input_schema: {
      type: 'object' as const,
      properties: {
        directory: { type: 'string', description: 'Directory path relative to repository root' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'finish',
    description: 'Signal that implementation is complete',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Summary of changes made (in Japanese)' },
      },
      required: ['summary'],
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

    case 'list_files': {
      const fullPath = path.join(WORKSPACE, input.directory)
      if (!fs.existsSync(fullPath)) return `Error: Directory not found: ${input.directory}`
      const entries = fs.readdirSync(fullPath, { withFileTypes: true })
      return entries.map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n')
    }

    case 'finish': {
      state.summary = input.summary
      state.done = true
      return 'Implementation marked as complete'
    }

    default:
      return `Error: Unknown tool: ${name}`
  }
}

async function runAgentLoop(
  client: Anthropic,
  initialPrompt: string,
  state: AgentState
): Promise<void> {
  state.messages.push({ role: 'user', content: initialPrompt })

  while (!state.done && state.turns < AGENT_MAX_TURNS) {
    state.turns++
    console.log(`Turn ${state.turns}/${AGENT_MAX_TURNS}`)

    const response = await client.messages.create({
      model: MODELS.agent,
      max_tokens: 8192,
      tools,
      messages: state.messages,
    })

    const assistantContent: Anthropic.ContentBlock[] = response.content
    state.messages.push({ role: 'assistant', content: assistantContent })

    if (response.stop_reason === 'end_turn') {
      console.log('Agent finished without calling finish tool')
      break
    }

    if (response.stop_reason !== 'tool_use') break

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue
      const result = executeTool(block.name, block.input as Record<string, string>, state)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      if (state.done) break
    }

    state.messages.push({ role: 'user', content: toolResults })
  }

  if (state.turns >= AGENT_MAX_TURNS && !state.done) {
    console.warn(`Agent reached max turns (${AGENT_MAX_TURNS}) without finishing`)
    state.summary = `実装を試みましたが、最大ターン数（${AGENT_MAX_TURNS}）に達したため完了できませんでした。手動での確認が必要です。`
  }
}

function getFileTree(): string {
  try {
    return execSync('find . -type f -not -path "./.git/*" -not -path "./node_modules/*" | head -100', {
      cwd: WORKSPACE,
      encoding: 'utf-8',
    })
  } catch {
    return '(could not retrieve file tree)'
  }
}

async function main() {
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? '')
  const issueTitle = process.env.ISSUE_TITLE ?? ''
  const issueBody = process.env.ISSUE_BODY ?? ''

  if (!issueNumber) throw new Error('ISSUE_NUMBER is required')

  const octokit = createOctokit()
  const creds = getRepoCreds()

  await postIssueComment(octokit, creds, issueNumber, `🤖 実装を開始します...（最大${AGENT_MAX_TURNS}ターン）`)

  const defaultBranch = await getDefaultBranch(octokit, creds)
  const baseSha = await getLatestCommitSha(octokit, creds, defaultBranch)
  const branchName = `ai-implement/issue-${issueNumber}`

  try {
    await createBranch(octokit, creds, branchName, baseSha)
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('Reference already exists')) {
      await postIssueComment(
        octokit, creds, issueNumber,
        `⚠️ ブランチ \`${branchName}\` が既に存在します。既に実装済みの可能性があります。`
      )
      return
    }
    throw e
  }

  const client = createClient()
  const state: AgentState = { messages: [], changes: [], summary: '', turns: 0, done: false }
  const prompt = buildImplementationPrompt(issueTitle, issueBody, getFileTree())

  await runAgentLoop(client, prompt, state)

  if (state.changes.length === 0) {
    await postIssueComment(octokit, creds, issueNumber, '⚠️ ファイルの変更が生成されませんでした。')
    return
  }

  await pushFilesToBranch(
    octokit, creds, branchName, state.changes,
    `feat: implement issue #${issueNumber}`
  )

  const prUrl = await createPullRequest(octokit, creds, {
    title: `[AI] ${issueTitle}`,
    body: `Closes #${issueNumber}\n\n## 変更内容\n\n${state.summary}\n\n---\n*このPRはAIによって自動生成されました（${state.turns}ターン使用）*`,
    head: branchName,
    base: defaultBranch,
  })

  await postIssueComment(
    octokit, creds, issueNumber,
    `✅ PRを作成しました: ${prUrl}\n\n${state.summary}`
  )

  console.log(`PR created: ${prUrl}`)
}

main().catch(async err => {
  console.error(err)
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? '')
  if (issueNumber) {
    try {
      const octokit = createOctokit()
      const creds = getRepoCreds()
      await postIssueComment(
        octokit, creds, issueNumber,
        `❌ 実装中にエラーが発生しました:\n\`\`\`\n${err.message}\n\`\`\``
      )
    } catch {}
  }
  process.exit(1)
})
