import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runDependencyChainAcceptanceProof,
  type RunDependencyChainAcceptanceProofInput,
} from "./WorkerAcceptanceProof.js";

const fixturePath = process.env.SANDCASTLE_DEPENDENCY_ACCEPTANCE_FIXTURE;

/** Opt-in live GitHub proof using three dedicated PRD leaves. */
describe.runIf(fixturePath !== undefined)(
  "live PRD dependency acceptance",
  () => {
    it("retains three freshly ordered verified draft publications", async () => {
      const fixture = (await import(pathToFileURL(fixturePath!).href)) as {
        readonly default:
          | RunDependencyChainAcceptanceProofInput
          | (() => Promise<RunDependencyChainAcceptanceProofInput>);
      };
      const input =
        typeof fixture.default === "function"
          ? await fixture.default()
          : fixture.default;

      const proof = await runDependencyChainAcceptanceProof(input);

      expect(proof.stages).toHaveLength(3);
      expect(proof.stages.every((stage) => stage.pullRequest.draft)).toBe(true);
    });
  },
);
