import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkerPocBoundaryAuditRecorder,
  type WorkerPocBoundaryAudit,
} from "./index.js";

describe("createWorkerPocBoundaryAuditRecorder", () => {
  it("atomically appends worker-owned events across fixture processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-poc-audit-"));
    const path = join(root, "audit.json");
    const first = createWorkerPocBoundaryAuditRecorder({
      path,
      runId: "deployed-gate-1",
      integrityKey: "test-audit-integrity-key",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    await first.record({
      action: "claim",
      executionIdentity: "execution-1",
      evidence: ["attempt-1"],
      timestamp: "2026-08-24T00:00:01.000Z",
    });

    const resumed = createWorkerPocBoundaryAuditRecorder({
      path,
      runId: "deployed-gate-1",
      integrityKey: "test-audit-integrity-key",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    await resumed.record({
      action: "verification",
      executionIdentity: "execution-1",
      evidence: ["/records/execution-1.json"],
      timestamp: "2026-08-24T00:00:02.000Z",
    });
    await resumed.record({
      action: "publication",
      executionIdentity: "execution-1",
      evidence: ["https://github.com/acme/app/pull/1"],
      timestamp: "2026-08-24T00:00:03.000Z",
    });

    const audit = JSON.parse(
      await readFile(path, "utf8"),
    ) as WorkerPocBoundaryAudit;
    expect(audit).toMatchObject({
      version: 1,
      runId: "deployed-gate-1",
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:00:03.000Z",
    });
    expect(audit.events).toEqual([
      expect.objectContaining({ actor: "worker", action: "claim" }),
      expect.objectContaining({ actor: "worker", action: "verification" }),
      expect.objectContaining({ actor: "worker", action: "publication" }),
    ]);
  });

  it("refuses to append a different run to an existing audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-poc-audit-"));
    const path = join(root, "audit.json");
    await createWorkerPocBoundaryAuditRecorder({
      path,
      runId: "first-run",
      integrityKey: "test-audit-integrity-key",
      startedAt: "2026-08-24T00:00:00.000Z",
    }).record({
      action: "claim",
      executionIdentity: "execution-1",
      evidence: ["attempt-1"],
      timestamp: "2026-08-24T00:00:01.000Z",
    });

    await expect(
      createWorkerPocBoundaryAuditRecorder({
        path,
        runId: "second-run",
        integrityKey: "test-audit-integrity-key",
        startedAt: "2026-08-24T00:00:00.000Z",
      }).record({
        action: "claim",
        executionIdentity: "execution-2",
        evidence: ["attempt-2"],
        timestamp: "2026-08-24T00:00:02.000Z",
      }),
    ).rejects.toThrow("belongs to a different run");
  });
});
