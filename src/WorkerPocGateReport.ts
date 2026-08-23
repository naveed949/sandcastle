import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  WorkerPocFutureEvidence,
  WorkerPocGateErrorCode,
  WorkerPocGateProof,
  WorkerPocLimitation,
} from "./WorkerPocGate.js";

export const workerPocLimitations: readonly WorkerPocLimitation[] = [
  {
    id: "single-worker",
    description: "The POC permits one dispatcher and one active execution.",
  },
  {
    id: "polling-only",
    description:
      "Discovery is polling-based; webhook delivery is not implemented.",
  },
  {
    id: "manual-recovery",
    description:
      "Started attempts with possible side effects require operator inspection.",
  },
  {
    id: "github-only",
    description:
      "Only the GitHub issue tracker has retained contract evidence.",
  },
  {
    id: "human-review",
    description:
      "Publications remain drafts; merge and task closure require humans.",
  },
];

export const workerPocFutureEvidence: readonly WorkerPocFutureEvidence[] = [
  {
    capability: "concurrency",
    requiredEvidence: [
      "Parallel claim contention retains exactly one winner per execution identity.",
      "Concurrent repositories preserve isolation, fairness, and deterministic recovery.",
    ],
  },
  {
    capability: "webhooks",
    requiredEvidence: [
      "Authenticated deliveries are replay-safe, deduplicated, and reconciled with polling.",
      "Out-of-order and missing events cannot bypass fresh eligibility checks.",
    ],
  },
  {
    capability: "auto-remediation",
    requiredEvidence: [
      "Retries are bounded, independently reverified, and retain every superseded attempt.",
      "Generated fixes cannot expand authorization or skip human-review policy.",
    ],
  },
  {
    capability: "issue-tracker-support",
    requiredEvidence: [
      "An issue-tracker contract suite proves equivalent identity, revision, relationship, and authorization semantics.",
      "Issue-tracker-specific writes remain behind the same guarded publication boundary.",
    ],
  },
];

const renderReport = (proof: WorkerPocGateProof): string => {
  const checkRows = Object.entries(proof.checks)
    .map(([name]) => `| ${name} | PASS |`)
    .join("\n");
  const limitationRows = proof.limitations
    .map((limitation) => `- **${limitation.id}:** ${limitation.description}`)
    .join("\n");
  const futureSections = proof.futureEvidence
    .map(
      (item) =>
        `### ${item.capability}\n\n${item.requiredEvidence.map((evidence) => `- ${evidence}`).join("\n")}`,
    )
    .join("\n\n");
  return `# Repo-agnostic worker POC gate: PASSED

Generated: ${proof.createdAt}

| Check | Result |
| --- | --- |
${checkRows}

The gate retained ${proof.publications.length} verified draft publications, including the restart-resumed draft. Every publication is bound to a task revision, base commit, execution-profile digest, prompt version and template digest, commits, verification results, and durable evidence references.

Guarded actions are correlated by execution identity in audit ${proof.boundaryAudit.runId} (${proof.boundaryAudit.digest}), retained at ${proof.boundaryAudit.path}.

Restart evidence preserved a started attempt for manual inspection and resumed a verified attempt through one deterministic branch and one idempotent draft pull request (${proof.restart.pullRequestUrl}).

## POC limitations

${limitationRows}

## Evidence required for expansion

${futureSections}
`;
};

type FailPocGate = (message: string, code: WorkerPocGateErrorCode) => never;

const retain = async (
  path: string,
  content: string,
  fail: FailPocGate,
): Promise<void> => {
  if (path.trim() === "")
    fail("Output paths must be non-empty.", "invalid_input");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
};

/** Atomically retain the machine proof and its operator-facing report. */
export const retainWorkerPocGateArtifacts = async (
  proofPath: string,
  reportPath: string,
  proof: WorkerPocGateProof,
  fail: FailPocGate,
): Promise<void> => {
  await retain(proofPath, `${JSON.stringify(proof, null, 2)}\n`, fail);
  await retain(reportPath, renderReport(proof), fail);
};
