import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runMissionControlAcceptanceProof,
  type RunMissionControlAcceptanceProofInput,
} from "./MissionControlAcceptanceProof.js";

const fixturePath = process.env.SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_FIXTURE;

/** Opt-in acceptance proof against the live remote Mission Control host. */
describe.runIf(fixturePath !== undefined)(
  "live Mission Control deployment acceptance",
  () => {
    it("retains the HTTP/SSE, control, durability, and publication proof", async () => {
      const fixture = (await import(pathToFileURL(fixturePath!).href)) as {
        readonly default:
          | RunMissionControlAcceptanceProofInput
          | (() => Promise<RunMissionControlAcceptanceProofInput>);
      };
      const input =
        typeof fixture.default === "function"
          ? await fixture.default()
          : fixture.default;

      const proof = await runMissionControlAcceptanceProof(input);

      expect(proof.status).toBe("passed");
      expect(proof.kind).toBe("mission-control-remote-deployment-acceptance");
      expect(proof.checks.serverSideCredentials).toBe(true);
      expect(proof.checks.manualInterventionProtection).toBe(true);
    });
  },
);
