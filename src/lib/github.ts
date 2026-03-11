import { Octokit } from '@octokit/rest'

export function createOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')
  return new Octokit({ auth: token })
}

export interface RepoCreds {
  owner: string
  repo: string
}

export function getRepoCreds(): RepoCreds {
  const owner = process.env.REPO_OWNER
  const repo = process.env.REPO_NAME
  if (!owner || !repo) throw new Error('REPO_OWNER or REPO_NAME is not set')
  return { owner, repo }
}

export async function postPRReview(
  octokit: Octokit,
  creds: RepoCreds,
  prNumber: number,
  body: string
): Promise<void> {
  await octokit.pulls.createReview({
    ...creds,
    pull_number: prNumber,
    body,
    event: 'COMMENT',
  })
}

export async function postIssueComment(
  octokit: Octokit,
  creds: RepoCreds,
  issueNumber: number,
  body: string
): Promise<void> {
  await octokit.issues.createComment({
    ...creds,
    issue_number: issueNumber,
    body,
  })
}

export async function getDefaultBranch(
  octokit: Octokit,
  creds: RepoCreds
): Promise<string> {
  const { data } = await octokit.repos.get(creds)
  return data.default_branch
}

export async function createBranch(
  octokit: Octokit,
  creds: RepoCreds,
  branchName: string,
  baseSha: string
): Promise<void> {
  await octokit.git.createRef({
    ...creds,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  })
}

export async function getLatestCommitSha(
  octokit: Octokit,
  creds: RepoCreds,
  branch: string
): Promise<string> {
  const { data } = await octokit.repos.getBranch({ ...creds, branch })
  return data.commit.sha
}

export async function pushFilesToBranch(
  octokit: Octokit,
  creds: RepoCreds,
  branch: string,
  files: Array<{ path: string; content: string }>,
  commitMessage: string
): Promise<void> {
  for (const file of files) {
    let sha: string | undefined
    try {
      const { data } = await octokit.repos.getContent({
        ...creds,
        path: file.path,
        ref: branch,
      })
      if (!Array.isArray(data) && 'sha' in data) sha = data.sha
    } catch {
      // ファイルが存在しない場合は新規作成
    }

    await octokit.repos.createOrUpdateFileContents({
      ...creds,
      path: file.path,
      message: commitMessage,
      content: Buffer.from(file.content).toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    })
  }
}

export async function createPullRequest(
  octokit: Octokit,
  creds: RepoCreds,
  params: { title: string; body: string; head: string; base: string }
): Promise<string> {
  const { data } = await octokit.pulls.create({ ...creds, ...params })
  return data.html_url
}
