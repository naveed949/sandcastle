import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runCrossRepositoryAcceptanceProof,
  type RunCrossRepositoryAcceptanceProofInput,
} from "./WorkerAcceptanceProof.js";

const fixturePath = process.env.SANDCASTLE_CROSS_REPO_ACCEPTANCE_FIXTURE;

/**
 * Opt-in live GitHub acceptance test. The fixture must construct the real
 * GitHub issue tracker, repository manager, execution engine, state stores, and
 * publisher for dedicated acceptance repositories. No boundary is mocked here.
 */
describe.runIf(fixturePath !== undefined)(
  "live cross-repository acceptance",
  () => {
    it("retains proof from GitHub discovery through three draft pull requests", async () => {
      const fixture = (await import(pathToFileURL(fixturePath!).href)) as {
        readonly default:
          | RunCrossRepositoryAcceptanceProofInput
          | (() => Promise<RunCrossRepositoryAcceptanceProofInput>);
      };
      const input =
        typeof fixture.default === "function"
          ? await fixture.default()
          : fixture.default;

      const proof = await runCrossRepositoryAcceptanceProof(input);

      expect(proof.runs).toHaveLength(3);
      expect(proof.runs.every((run) => run.pullRequest.draft)).toBe(true);
    });
  },
);
