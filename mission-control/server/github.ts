import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface GhIssue {
  number: number;
  title: string;
  body: string;
}

const REPOSITORY_PART = "[A-Za-z0-9_.-]+";
const REPOSITORY_PATTERNS = [
  new RegExp(`^(${REPOSITORY_PART})/(${REPOSITORY_PART})$`),
  new RegExp(
    `^https?://github\\.com/(${REPOSITORY_PART})/(${REPOSITORY_PART})/?$`,
    "i",
  ),
  new RegExp(
    `^ssh://git@github\\.com/(${REPOSITORY_PART})/(${REPOSITORY_PART})/?$`,
    "i",
  ),
  new RegExp(
    `^git@github\\.com:(${REPOSITORY_PART})/(${REPOSITORY_PART})$`,
    "i",
  ),
];

/** Normalizes a UI repository value to the owner/repo form used by gh. */
export function parseRepositorySlug(value: string): string {
  const candidate = value
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/i, "");
  for (const pattern of REPOSITORY_PATTERNS) {
    const match = candidate.match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  throw new Error(`Not a GitHub repository: ${value}`);
}

export function parseIssueUrl(url: string): {
  owner: string;
  repo: string;
  issueNumber: number;
} {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
  if (!m) {
    throw new Error(`Not a GitHub issue URL: ${url}`);
  }
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/, ""),
    issueNumber: Number(m[3]),
  };
}

async function gh<T>(args: string[]): Promise<T> {
  const { stdout } = await pExecFile("gh", args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

interface SubIssueEdge {
  items: { number: number; title: string; body: string }[];
}

async function fetchSubIssues(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GhIssue[]> {
  // Native sub-issue relationship, read via GraphQL.
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          subIssues(first: 100) {
            nodes { number title body }
          }
        }
      }
    }`;
  const data = await gh<{
    data: {
      repository: { issue: { subIssues: SubIssueEdge & { nodes: GhIssue[] } } };
    };
  }>([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    `number=${issueNumber}`,
  ]);
  return data.data.repository.issue.subIssues.nodes;
}

async function fetchBlockedBy(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number[]> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          blockedByIssues(first: 100) {
            nodes { number }
          }
        }
      }
    }`;
  const data = await gh<{
    data: {
      repository: {
        issue: { blockedByIssues: { nodes: { number: number }[] } };
      };
    };
  }>([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    `number=${issueNumber}`,
  ]);
  return data.data.repository.issue.blockedByIssues.nodes.map((n) => n.number);
}

export function parseBlockedByFromBody(body: string): number[] {
  const section = body.split(/^##\s*Blocked by\s*$/im)[1];
  if (!section) return [];
  const sectionText = section.split(/^##\s/im)[0];
  const numbers = [...sectionText.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(numbers)];
}

export async function fetchPrdTickets(
  prdIssueUrl: string,
): Promise<(GhIssue & { blockers: number[] })[]> {
  const { owner, repo, issueNumber } = parseIssueUrl(prdIssueUrl);
  let subIssues = await fetchSubIssues(owner, repo, issueNumber);
  // Fallback: PRDs without native sub-issues — use ready-for-agent labeled
  // open issues instead (the to-tickets convention).
  if (subIssues.length === 0) {
    subIssues = await gh<GhIssue[]>([
      "issue",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--state",
      "open",
      "--label",
      "ready-for-agent",
      "--limit",
      "200",
      "--json",
      "number,title,body",
    ]);
  }
  const tickets: (GhIssue & { blockers: number[] })[] = [];
  for (const issue of subIssues) {
    let blockers: number[];
    try {
      blockers = await fetchBlockedBy(owner, repo, issue.number);
    } catch {
      blockers = parseBlockedByFromBody(issue.body);
    }
    if (blockers.length === 0) {
      blockers = parseBlockedByFromBody(issue.body);
    }
    tickets.push({ ...issue, blockers });
  }
  return tickets;
}

export async function closeIssueWithComment(
  owner: string,
  repo: string,
  issueNumber: number,
  comment: string,
): Promise<void> {
  await pExecFile("gh", [
    "issue",
    "close",
    String(issueNumber),
    "--repo",
    `${owner}/${repo}`,
    "--comment",
    comment,
  ]);
}

export async function fetchIssueState(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<"open" | "closed"> {
  const { stdout } = await pExecFile("gh", [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "state",
    "-q",
    ".state",
  ]);
  return stdout.trim().toLowerCase() === "closed" ? "closed" : "open";
}

export async function createPullRequest(opts: {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  const { stdout } = await pExecFile(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      `${opts.owner}/${opts.repo}`,
      "--head",
      opts.head,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  return stdout.trim().split("\n").pop()!.trim();
}
