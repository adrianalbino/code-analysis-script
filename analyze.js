#!/usr/bin/env node

require("dotenv").config({ path: __dirname + "/.env" });
const { execFileSync } = require("child_process");
const OpenAI = require("openai").default;

const DAYS_BACK = 7;
const MAX_DIFF_CHARS = 6000;
const USERNAME = process.argv[2] || "adrianalbino";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function getSinceDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split("T")[0];
}

function fetchCommits(username, sinceStr) {
  // Search all commits by this user across GitHub
  const query = `author:${username} author-date:>=${sinceStr}`;
  const result = gh([
    "api", "search/commits",
    "--method", "GET",
    "-f", `q=${query}`,
    "-f", "sort=author-date",
    "-f", "order=desc",
    "-f", "per_page=100",
    "--jq", `.items[] | {sha: .sha, date: .commit.author.date, message: .commit.message, repo: .repository.full_name, url: .html_url}`
  ]);

  if (!result) return [];

  return result.split("\n").reduce((acc, line) => {
    if (!line.trim()) return acc;
    try {
      acc.push(JSON.parse(line));
    } catch {}
    return acc;
  }, []);
}

function fetchDiff(repo, sha) {
  try {
    const result = gh([
      "api", `repos/${repo}/commits/${sha}`,
      "--jq", `.files[] | "\\(.filename) | +\\(.additions) -\\(.deletions)\\n\\(.patch // "")"`,
    ]);
    return result;
  } catch {
    return "(diff unavailable)";
  }
}

function getStats(commits, diffs) {
  let totalInsertions = 0;
  let totalDeletions = 0;
  let totalFiles = 0;

  for (const diff of diffs) {
    const lines = diff.split("\n");
    for (const line of lines) {
      const match = line.match(/\| \+(\d+) -(\d+)/);
      if (match) {
        totalInsertions += parseInt(match[1]);
        totalDeletions += parseInt(match[2]);
        totalFiles++;
      }
    }
  }

  return { totalFiles, totalInsertions, totalDeletions };
}

function buildTimeline(commits) {
  const days = {};
  for (const c of commits) {
    const d = new Date(c.date);
    const dayKey = d.toISOString().split("T")[0];
    const hour = d.getHours();
    if (!days[dayKey]) days[dayKey] = [];
    days[dayKey].push({ hour, message: c.message.split("\n")[0], repo: c.repo });
  }
  return days;
}

async function analyze(commits, diffs, stats, timeline, username) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
  }
  const client = new OpenAI();

  const commitDetails = commits.map((c, i) => {
    let diff = diffs[i] || "(no diff available)";
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... [truncated]";
    }
    return `### [${c.repo}] ${c.message.split("\n")[0]}\nDate: ${c.date}\nSHA: ${c.sha}\n\n\`\`\`diff\n${diff}\n\`\`\``;
  });

  const timelineStr = Object.entries(timeline)
    .map(([day, entries]) => {
      const hours = entries.map((e) => `${e.hour}:00 - [${e.repo}] "${e.message}"`).join("\n  ");
      return `${day}:\n  ${hours}`;
    })
    .join("\n");

  const repos = [...new Set(commits.map((c) => c.repo))];

  const prompt = `You are a senior engineering manager and code quality expert. Analyze the following git activity from developer "${username}" over the past ${DAYS_BACK} days across all their GitHub repositories.

## Repositories with activity
${repos.map((r) => `- ${r}`).join("\n")}

## Overall Statistics
- Total commits: ${commits.length}
- Files changed: ${stats.totalFiles}
- Lines added: ${stats.totalInsertions}
- Lines deleted: ${stats.totalDeletions}
- Net lines: ${stats.totalInsertions - stats.totalDeletions}

## Commit Timeline (day -> hours of activity)
${timelineStr}

## Commit Details
${commitDetails.join("\n\n---\n\n")}

---

Provide a thorough analysis with the following sections. Be specific — reference actual code, filenames, and patterns you observe. Do not be generic.

### 1. CODE QUALITY ANALYSIS
Rate each area 1-10 and explain with concrete examples from the diffs:
- **Readability & naming**: Are variable/function names clear? Is the code self-documenting?
- **Structure & modularity**: Is code well-organized? Are functions/components appropriately sized?
- **Error handling**: Are edge cases handled? Is there defensive programming where needed?
- **DRY / duplication**: Any repeated patterns that should be abstracted?
- **Security awareness**: Any potential vulnerabilities (XSS, injection, exposed secrets, etc.)?
- **Testing**: Are tests present? Are they meaningful?
- **Overall quality score**: Weighted average of the above (1-10)

### 2. HOURS ESTIMATION
Estimate total hours spent writing this code. Use these signals:
- **Commit timestamps**: Look at gaps between commits, time-of-day patterns, and clustering. A burst of commits in a 2-hour window likely represents a focused session. Gaps of 4+ hours likely mean a break.
- **Complexity of changes**: A 500-line refactor of complex logic takes longer per line than adding simple config entries. Weight by cognitive difficulty.
- **Research/debugging overhead**: If commits show iterative fixes (fix, then fix the fix), add debugging time. If the code uses unfamiliar APIs or complex algorithms, add research time.
- **Non-coding work**: Account for ~30% overhead for code review, context switching, reading docs, and planning that doesn't show up in diffs.

Provide:
- Estimated pure coding hours (time fingers were on keyboard)
- Estimated total working hours (including research, debugging, review, planning)
- Confidence level (low/medium/high) and reasoning
- Breakdown by day if possible

### 3. WORK PATTERNS & PRODUCTIVITY INSIGHTS
- What days/times is this developer most active?
- Are commit messages descriptive and consistent?
- Is work spread evenly or done in bursts?
- Any signs of rushing (large unfocused commits) or over-engineering?
- How is work distributed across repos?

### 4. RECOMMENDATIONS
- Top 3 specific, actionable improvements for code quality
- Any workflow improvements based on commit patterns

Keep the analysis honest and constructive. If there's not enough data for a confident assessment in any area, say so explicitly rather than guessing.`;

  console.log("\nAnalyzing with GPT-4o...\n");

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const choice = response.choices[0];
  if (!choice || !choice.message?.content) {
    console.error("Unexpected API response format:", JSON.stringify(response.choices));
    process.exit(1);
  }
  return choice.message.content;
}

async function main() {
  const sinceStr = getSinceDate(DAYS_BACK);

  console.log(`Fetching commits for: ${USERNAME}`);
  console.log(`Period: last ${DAYS_BACK} days (since ${sinceStr})\n`);

  const commits = fetchCommits(USERNAME, sinceStr);

  if (commits.length === 0) {
    console.log("No commits found in the past week. Nothing to analyze.");
    process.exit(0);
  }

  const repos = [...new Set(commits.map((c) => c.repo))];
  console.log(`Found ${commits.length} commits across ${repos.length} repo(s): ${repos.join(", ")}`);
  console.log("Fetching diffs...");

  const diffs = commits.map((c) => fetchDiff(c.repo, c.sha));
  const stats = getStats(commits, diffs);
  const timeline = buildTimeline(commits);

  console.log(`Stats: +${stats.totalInsertions} -${stats.totalDeletions} across ${stats.totalFiles} files`);

  const analysis = await analyze(commits, diffs, stats, timeline, USERNAME);

  console.log("=".repeat(70));
  console.log("  WEEKLY CODE ANALYSIS REPORT");
  console.log("=".repeat(70));
  console.log(`  User: ${USERNAME}`);
  console.log(`  Repos: ${repos.join(", ")}`);
  console.log(`  Period: Last ${DAYS_BACK} days`);
  console.log(`  Commits: ${commits.length}`);
  console.log("=".repeat(70));
  console.log();
  console.log(analysis);
  console.log();
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
