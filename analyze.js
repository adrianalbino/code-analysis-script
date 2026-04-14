#!/usr/bin/env node

require("dotenv").config({ path: __dirname + "/.env" });
const { execFileSync } = require("child_process");
const path = require("path");
const OpenAI = require("openai").default;

const DAYS_BACK = 7;
const MAX_DIFF_CHARS = 6000;
const MAX_BUFFER = 10 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: MAX_BUFFER }).trim();
}

function gitSafe(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

function getSinceDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split("T")[0];
}

function getRepoPath() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node analyze.js <path-to-git-repo>");
    process.exit(1);
  }
  const resolved = path.resolve(arg);
  const check = gitSafe(["rev-parse", "--git-dir"], resolved);
  if (!check) {
    console.error(`Error: "${resolved}" is not a git repository.`);
    process.exit(1);
  }
  return resolved;
}

function pullLatest(repoPath) {
  console.log("Pulling latest changes...");
  try {
    const result = git(["pull", "--ff-only"], repoPath);
    console.log(result || "Already up to date.");
  } catch (err) {
    console.warn("git pull failed (continuing with local state):", err.message.split("\n")[0]);
  }
}

function getAuthorName(repoPath) {
  return gitSafe(["config", "user.name"], repoPath) || execFileSync("whoami", { encoding: "utf-8" }).trim();
}

function getCommits(repoPath, author, sinceStr) {
  const log = gitSafe(
    ["log", `--author=${author}`, `--since=${sinceStr}`, "--pretty=format:%H|||%ai|||%s", "--no-merges"],
    repoPath
  );

  if (!log) return [];

  return log.split("\n").map((line) => {
    const [hash, date, ...rest] = line.split("|||");
    return { hash, date, message: rest.join("|||") };
  });
}

function getDiff(repoPath, hash) {
  // For root commits, diff against the empty tree
  const hasParent = gitSafe(["rev-parse", "--verify", `${hash}^`], repoPath);
  const range = hasParent ? [`${hash}~1..${hash}`] : [`4b825dc642cb6eb9a060e54bf8d69288fbee4904`, hash];

  const stat = gitSafe(["diff", ...range, "--stat"], repoPath);
  const diff = gitSafe([
    "diff", ...range, "-U3",
    "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json", ":(exclude)*.min.js", ":(exclude)*.min.css"
  ], repoPath);
  return stat + "\n---DIFF---\n" + diff;
}

function getOverallStats(repoPath, author, sinceStr) {
  const shortlog = gitSafe(
    ["log", `--author=${author}`, `--since=${sinceStr}`, "--no-merges", "--shortstat", "--pretty=format:"],
    repoPath
  );

  let totalInsertions = 0;
  let totalDeletions = 0;
  let totalFiles = 0;

  for (const line of shortlog.split("\n")) {
    const filesMatch = line.match(/(\d+) files? changed/);
    const insMatch = line.match(/(\d+) insertions?/);
    const delMatch = line.match(/(\d+) deletions?/);
    if (filesMatch) totalFiles += parseInt(filesMatch[1]);
    if (insMatch) totalInsertions += parseInt(insMatch[1]);
    if (delMatch) totalDeletions += parseInt(delMatch[1]);
  }

  return { totalFiles, totalInsertions, totalDeletions };
}

function buildCommitTimeline(commits) {
  const days = {};
  for (const c of commits) {
    const d = new Date(c.date);
    const dayKey = d.toISOString().split("T")[0];
    const hour = d.getHours();
    if (!days[dayKey]) days[dayKey] = [];
    days[dayKey].push({ hour, message: c.message });
  }
  return days;
}

async function analyzeWithClaude(commits, diffs, stats, timeline, author) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
  }
  const client = new OpenAI();

  const commitDetails = commits.map((c, i) => {
    let diff = diffs[i] || "(no diff available)";
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated for brevity]";
    }
    return `### Commit: ${c.message}\nDate: ${c.date}\nHash: ${c.hash}\n\n\`\`\`diff\n${diff}\n\`\`\``;
  });

  const timelineStr = Object.entries(timeline)
    .map(([day, entries]) => {
      const hours = entries.map((e) => `${e.hour}:00 - "${e.message}"`).join("\n  ");
      return `${day}:\n  ${hours}`;
    })
    .join("\n");

  const prompt = `You are a senior engineering manager and code quality expert. Analyze the following git activity from developer "${author}" over the past ${DAYS_BACK} days.

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

### 4. RECOMMENDATIONS
- Top 3 specific, actionable improvements for code quality
- Any workflow improvements based on commit patterns

Keep the analysis honest and constructive. If there's not enough data for a confident assessment in any area, say so explicitly rather than guessing.`;

  console.log("\nAnalyzing with Claude...\n");

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
  const repoPath = getRepoPath();

  pullLatest(repoPath);

  const author = getAuthorName(repoPath);
  console.log(`\nAnalyzing commits by: ${author}`);
  console.log(`Period: last ${DAYS_BACK} days\n`);

  const sinceStr = getSinceDate(DAYS_BACK);
  const commits = getCommits(repoPath, author, sinceStr);

  if (commits.length === 0) {
    console.log("No commits found in the past week. Nothing to analyze.");
    process.exit(0);
  }

  console.log(`Found ${commits.length} commits. Gathering diffs...`);

  const diffs = commits.map((c) => getDiff(repoPath, c.hash));
  const stats = getOverallStats(repoPath, author, sinceStr);
  const timeline = buildCommitTimeline(commits);

  console.log(`Stats: ${stats.totalInsertions} additions, ${stats.totalDeletions} deletions across ${stats.totalFiles} files`);

  const analysis = await analyzeWithClaude(commits, diffs, stats, timeline, author);

  console.log("=".repeat(70));
  console.log("  WEEKLY CODE ANALYSIS REPORT");
  console.log("=".repeat(70));
  console.log(`  Author: ${author}`);
  console.log(`  Repository: ${repoPath}`);
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
