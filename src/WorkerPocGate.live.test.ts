import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runWorkerPocGate,
  type RunWorkerPocGateInput,
} from "./WorkerPocGate.js";

const fixturePath = process.env.SANDCASTLE_POC_GATE_FIXTURE;

/** Opt-in consolidated gate against retained deployed-worker evidence. */
describe.runIf(fixturePath !== undefined)("live worker POC gate", () => {
  it("retains the complete machine proof and operator report", async () => {
    const fixture = (await import(pathToFileURL(fixturePath!).href)) as {
      readonly default:
        | RunWorkerPocGateInput
        | (() => Promise<RunWorkerPocGateInput>);
    };
    const input =
      typeof fixture.default === "function"
        ? await fixture.default()
        : fixture.default;

    const proof = await runWorkerPocGate(input);

    expect(proof.status).toBe("passed");
    expect(proof.publications).toHaveLength(7);
    expect(Object.values(proof.checks).every(Boolean)).toBe(true);
  });
});
