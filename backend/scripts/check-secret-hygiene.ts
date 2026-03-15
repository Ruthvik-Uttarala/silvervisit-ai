import { spawnSync } from "node:child_process";
import path from "node:path";

interface SecretPattern {
  id: string;
  regex: string;
  description: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "google-api-key",
    regex: "AIza[0-9A-Za-z\\-_]{35}",
    description: "Google API key pattern",
  },
  {
    id: "oauth-access-token",
    regex: "ya29\\.[0-9A-Za-z\\-_]+",
    description: "OAuth access token pattern",
  },
  {
    id: "private-key",
    regex: "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    description: "Private key header",
  },
  {
    id: "github-token",
    regex: "ghp_[0-9A-Za-z]{36}",
    description: "GitHub token pattern",
  },
];

function runGit(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function getRepoRoot(cwd: string): string {
  const result = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.status !== 0) {
    throw new Error(`Failed to resolve git repo root: ${result.stderr.trim() || "unknown git error"}`);
  }
  return result.stdout.trim();
}

function scanPattern(repoRoot: string, pattern: SecretPattern): string[] {
  const grepArgs = ["grep", "-nI", "-E", "-e", pattern.regex, "--", "."];
  const result = runGit(grepArgs, repoRoot);
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(`git grep failed for ${pattern.id}: ${result.stderr.trim() || "unknown grep error"}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(): void {
  const repoRoot = getRepoRoot(path.resolve(__dirname, ".."));
  const findings: Array<{ pattern: SecretPattern; matches: string[] }> = [];

  for (const pattern of SECRET_PATTERNS) {
    const matches = scanPattern(repoRoot, pattern);
    if (matches.length > 0) {
      findings.push({ pattern, matches });
    }
  }

  if (findings.length > 0) {
    console.error("[hygiene] Potential secret leakage detected in tracked files:");
    for (const finding of findings) {
      console.error(`- ${finding.pattern.id}: ${finding.pattern.description}`);
      for (const match of finding.matches.slice(0, 10)) {
        console.error(`  ${match}`);
      }
      if (finding.matches.length > 10) {
        console.error(`  ... ${finding.matches.length - 10} more match(es)`);
      }
    }
    process.exit(1);
  }

  console.log("[hygiene] no secrets detected in tracked files");
}

main();
