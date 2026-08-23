import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  WorkerPocBoundaryAction,
  WorkerPocBoundaryAudit,
  WorkerPocGateErrorCode,
  WorkerPocGateProof,
  WorkerPocPublicationProvenance,
} from "./WorkerPocGate.js";
import type {
  WorkerGuardedActionEvent,
  WorkerGuardedActionRecorder,
} from "./WorkerGuardedActions.js";
import { canonicalJson } from "./CanonicalJson.js";

type FailPocGate = (message: string, code: WorkerPocGateErrorCode) => never;

export type WorkerPocBoundaryAuditRecordInput = WorkerGuardedActionEvent;

/** The only supported producer for retained worker-owned boundary events. */
export type WorkerPocBoundaryAuditRecorder = WorkerGuardedActionRecorder;

export interface CreateWorkerPocBoundaryAuditRecorderInput {
  readonly path: string;
  readonly runId: string;
  readonly integrityKey: string;
  readonly startedAt?: string;
  readonly now?: () => string;
}

const validTimestamp = (value: string): boolean =>
  Number.isFinite(Date.parse(value));

const integrityFor = (
  key: string,
  audit: Pick<WorkerPocBoundaryAudit, "runId" | "startedAt" | "events">,
): WorkerPocBoundaryAudit["integrity"] => {
  const eventDigests: string[] = [];
  let previousDigest = "0".repeat(64);
  for (const [index, event] of audit.events.entries()) {
    previousDigest = createHmac("sha256", key)
      .update(
        canonicalJson({
          runId: audit.runId,
          startedAt: audit.startedAt,
          index,
          previousDigest,
          event,
        }),
      )
      .digest("hex");
    eventDigests.push(previousDigest);
  }
  return {
    algorithm: "hmac-sha256",
    eventDigests,
    rootDigest: previousDigest,
  };
};

const readExistingAudit = async (
  path: string,
): Promise<WorkerPocBoundaryAudit | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as WorkerPocBoundaryAudit;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
};

const retainAudit = async (
  path: string,
  audit: WorkerPocBoundaryAudit,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
};

/** Create a worker-owned, append-only recorder scoped to one deployed gate run. */
export const createWorkerPocBoundaryAuditRecorder = (
  input: CreateWorkerPocBoundaryAuditRecorderInput,
): WorkerPocBoundaryAuditRecorder => {
  const path = input.path.trim();
  const runId = input.runId.trim();
  const integrityKey = input.integrityKey;
  const now = input.now ?? (() => new Date().toISOString());
  const initialStartedAt = input.startedAt ?? now();
  if (
    path === "" ||
    runId === "" ||
    integrityKey.length < 16 ||
    !validTimestamp(initialStartedAt)
  ) {
    throw new Error("Boundary audit path, runId, and startedAt must be valid.");
  }
  return {
    record: async (event) => {
      const timestamp = event.timestamp ?? now();
      if (
        event.executionIdentity.trim() === "" ||
        event.evidence.length === 0 ||
        event.evidence.some((item) => item.trim() === "") ||
        !validTimestamp(timestamp)
      ) {
        throw new Error("Boundary audit event is incomplete.");
      }
      const existing = await readExistingAudit(path);
      if (
        existing !== undefined &&
        (existing.version !== 1 ||
          existing.runId !== runId ||
          canonicalJson(existing.integrity) !==
            canonicalJson(integrityFor(integrityKey, existing)))
      ) {
        throw new Error("Boundary audit path belongs to a different run.");
      }
      const startedAt = existing?.startedAt ?? initialStartedAt;
      if (
        !validTimestamp(startedAt) ||
        Date.parse(timestamp) < Date.parse(startedAt) ||
        (existing !== undefined &&
          Date.parse(timestamp) < Date.parse(existing.completedAt))
      ) {
        throw new Error("Boundary audit event predates the run.");
      }
      const matchingEvent = existing?.events.find(
        (candidate) =>
          candidate.action === event.action &&
          candidate.executionIdentity === event.executionIdentity,
      );
      if (matchingEvent !== undefined) {
        if (
          JSON.stringify(matchingEvent.evidence) !==
          JSON.stringify(event.evidence)
        ) {
          throw new Error("Boundary audit action has conflicting evidence.");
        }
        return;
      }
      const nextAudit = {
        version: 1,
        runId,
        startedAt,
        completedAt: timestamp,
        events: [
          ...(existing?.events ?? []),
          {
            timestamp,
            actor: "worker",
            action: event.action,
            executionIdentity: event.executionIdentity,
            evidence: [...event.evidence],
          },
        ],
      } satisfies Omit<WorkerPocBoundaryAudit, "integrity">;
      await retainAudit(path, {
        ...nextAudit,
        integrity: integrityFor(integrityKey, nextAudit),
      });
    },
  };
};

/** Read, validate, correlate, and fingerprint one deployed privileged-action audit. */
export const readWorkerPocBoundaryAudit = async (
  path: string,
  integrityKey: string,
  publications: readonly WorkerPocPublicationProvenance[],
  fail: FailPocGate,
): Promise<WorkerPocGateProof["boundaryAudit"]> => {
  let content: Buffer;
  let audit: WorkerPocBoundaryAudit;
  try {
    content = await readFile(path);
    audit = JSON.parse(content.toString("utf8")) as WorkerPocBoundaryAudit;
  } catch (error) {
    return fail(
      `Boundary audit ${path} could not be read: ${String(error)}`,
      "boundary_bypass",
    );
  }
  const actions = new Set<WorkerPocBoundaryAction>([
    "claim",
    "verification",
    "publication",
    "merge",
    "closure",
    "github-command",
  ]);
  const validEvents =
    Array.isArray(audit.events) &&
    audit.events.every(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        typeof event.timestamp === "string" &&
        (event.actor === "worker" ||
          event.actor === "agent" ||
          event.actor === "operator") &&
        actions.has(event.action) &&
        (event.executionIdentity === undefined ||
          typeof event.executionIdentity === "string") &&
        Array.isArray(event.evidence) &&
        event.evidence.every((item: unknown) => typeof item === "string"),
    );
  const startedAt = Date.parse(audit.startedAt ?? "");
  const completedAt = Date.parse(audit.completedAt ?? "");
  let validIntegrity = false;
  try {
    validIntegrity =
      integrityKey.length >= 16 &&
      audit.integrity?.algorithm === "hmac-sha256" &&
      canonicalJson(audit.integrity) ===
        canonicalJson(integrityFor(integrityKey, audit));
  } catch {
    validIntegrity = false;
  }
  if (
    audit.version !== 1 ||
    typeof audit.runId !== "string" ||
    audit.runId.trim() === "" ||
    typeof audit.startedAt !== "string" ||
    typeof audit.completedAt !== "string" ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    startedAt > completedAt ||
    !validEvents ||
    !validIntegrity
  ) {
    fail("The retained boundary audit is invalid.", "boundary_bypass");
  }
  const privileged = new Set<WorkerPocBoundaryAction>([
    "claim",
    "verification",
    "publication",
    "merge",
    "closure",
  ]);
  if (
    audit.events.length !== publications.length * 3 ||
    audit.events.some((event) => {
      const timestamp = Date.parse(event.timestamp);
      return (
        !Number.isFinite(timestamp) ||
        timestamp < startedAt ||
        timestamp > completedAt ||
        event.action === "github-command" ||
        event.action === "merge" ||
        event.action === "closure" ||
        (event.actor === "agent" && privileged.has(event.action))
      );
    })
  ) {
    fail(
      "The retained audit observed a privileged action outside guarded worker boundaries.",
      "boundary_bypass",
    );
  }

  for (const publication of publications) {
    const claimIndex = audit.events.findIndex(
      (event) =>
        event.actor === "worker" &&
        event.action === "claim" &&
        event.executionIdentity === publication.executionIdentity,
    );
    const verificationIndex = audit.events.findIndex(
      (event, index) =>
        index > claimIndex &&
        event.actor === "worker" &&
        event.action === "verification" &&
        event.executionIdentity === publication.executionIdentity &&
        event.evidence.includes(publication.executionRecordPath),
    );
    const publicationIndex = audit.events.findIndex(
      (event, index) =>
        index > verificationIndex &&
        event.actor === "worker" &&
        event.action === "publication" &&
        event.executionIdentity === publication.executionIdentity &&
        event.evidence.includes(publication.pullRequestUrl),
    );
    if (
      claimIndex < 0 ||
      verificationIndex < 0 ||
      publicationIndex < 0 ||
      audit.events.filter(
        (event) =>
          event.executionIdentity === publication.executionIdentity &&
          (event.action === "claim" ||
            event.action === "verification" ||
            event.action === "publication"),
      ).length !== 3
    ) {
      fail(
        `Boundary audit does not retain the guarded action sequence for ${publication.taskId}.`,
        "boundary_bypass",
      );
    }
  }

  return {
    path,
    digest: createHash("sha256").update(content).digest("hex"),
    runId: audit.runId,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    eventCount: audit.events.length,
  };
};
