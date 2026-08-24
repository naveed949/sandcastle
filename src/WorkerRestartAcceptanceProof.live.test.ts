import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runWorkerRestartAcceptanceProof,
  type RunWorkerRestartAcceptanceProofInput,
} from "./WorkerRestartAcceptanceProof.js";

const fixturePath = process.env.SANDCASTLE_RESTART_ACCEPTANCE_FIXTURE;

/** Opt-in replacement-service recovery proof against live retained state. */
describe.runIf(fixturePath !== undefined)("live restart acceptance", () => {
  it("captures state and live branch/PR observations around replacement", async () => {
    const fixture = (await import(pathToFileURL(fixturePath!).href)) as {
      readonly default:
        | RunWorkerRestartAcceptanceProofInput
        | (() => Promise<RunWorkerRestartAcceptanceProofInput>);
    };
    const input =
      typeof fixture.default === "function"
        ? await fixture.default()
        : fixture.default;

    const proof = await runWorkerRestartAcceptanceProof(input);

    expect(proof.interrupted.beforeRestart.attempts).toHaveLength(1);
    expect(proof.interrupted.afterRestart.attempts).toHaveLength(1);
    expect(proof.verifiedPublication.observedPullRequests).toHaveLength(1);
  });
});
