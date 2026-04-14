# code-analysis-script

CLI tool that pulls your latest code from GitHub and analyzes your commits from the past week — code quality, estimated hours, and work patterns — using GPT-4o.

## setup

```bash
npm install
```

Create a `.env` file in the project root:

```
OPENAI_API_KEY=sk-...
```

## usage

```bash
node analyze.js /path/to/your/git/repo
```

It will:

1. Pull the latest changes from the remote
2. Find all your commits from the past 7 days
3. Collect diffs and stats
4. Send everything to GPT-4o for analysis
5. Print a report covering:
   - Code quality ratings (readability, structure, error handling, DRY, security, testing)
   - Estimated coding hours and total working hours
   - Work patterns and productivity insights
   - Actionable recommendations

## notes

- Uses your `git config user.name` to find your commits
- Excludes lock files and minified assets from diffs
- Requires Node.js 18+
