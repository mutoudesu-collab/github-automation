export function buildReviewPrompt(diff: string, prTitle: string, prBody: string): string {
  return `You are an expert code reviewer. Review the following pull request diff and provide actionable feedback.

## PR Title
${prTitle}

## PR Description
${prBody || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

Analyze for:
1. Bugs and logic errors
2. Security vulnerabilities (injection, XSS, auth bypass, etc.)
3. Performance issues
4. Code quality and maintainability

Respond in the following JSON format only:
{
  "summary": "Overall assessment in 1-2 sentences",
  "issues": [
    {
      "severity": "critical|warning|suggestion",
      "file": "path/to/file.ts",
      "description": "Clear description of the issue and how to fix it"
    }
  ]
}

If there are no issues, return an empty "issues" array.
Respond in Japanese.`
}

export function buildImplementationPrompt(
  issueTitle: string,
  issueBody: string,
  fileTree: string
): string {
  return `You are an expert software engineer. Implement the following GitHub issue.

## Issue Title
${issueTitle}

## Issue Description
${issueBody || '(no description)'}

## Repository File Tree
${fileTree}

Use the available tools to:
1. Read relevant existing files to understand the codebase
2. Write or update files to implement the requested feature/fix
3. Keep changes minimal and focused on the issue

Rules:
- Read files before modifying them
- Do not add unnecessary comments or docstrings
- Do not over-engineer; implement only what the issue asks for
- When done, call the finish tool with a summary of changes made`
}

export function buildDepFixPrompt(testOutput: string, packageDiff: string): string {
  return `You are an expert software engineer. Dependencies were upgraded and tests are now failing. Fix the code to make the tests pass.

## Updated Packages (package.json diff)
\`\`\`diff
${packageDiff}
\`\`\`

## Test Failure Output
\`\`\`
${testOutput}
\`\`\`

Use the available tools to:
1. Read the failing test files and source files
2. Identify what API changes in the upgraded packages caused the failures
3. Fix the source code (not the tests) to work with the new package versions

Rules:
- Fix only what is broken by the dependency upgrade
- Do not change test logic
- When done, call the finish tool with a summary of changes made`
}
