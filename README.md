# code-analysis-script

CLI tool that fetches all your GitHub commits from the past week across every repo and analyzes them — code quality, estimated hours, and work patterns — using GPT-4o.

## setup

```bash
npm install
```

Create a `.env` file in the project root:

```
OPENAI_API_KEY=sk-...
```

You also need the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated.

## usage

```bash
node analyze.js              # defaults to adrianalbino
node analyze.js <username>   # analyze any GitHub user
```

It will:

1. Fetch all commits from the past 7 days across every repo via the GitHub API
2. Pull diffs for each commit
3. Send everything to GPT-4o for analysis
4. Print a report covering:
   - Code quality ratings (readability, structure, error handling, DRY, security, testing)
   - Estimated coding hours and total working hours
   - Work patterns and productivity insights
   - Actionable recommendations

## notes

- Uses `gh api` (GitHub CLI) to search commits — works with public and your private repos
- No local git repos needed
- Requires Node.js 18+
