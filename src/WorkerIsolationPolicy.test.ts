import { describe, expect, it } from "vitest";
import {
  containsProtectedWorkerMaterial,
  isRepositoryCredentialName,
  repositoryCredentialNamesInEnvironmentFile,
} from "./WorkerIsolationPolicy.js";

describe("worker isolation policy", () => {
  it("recognizes repository authority across environment mechanisms", () => {
    expect(
      [
        "GITHUB_TOKEN",
        "GIT_ASKPASS",
        "GIT_CONFIG_VALUE_0",
        "SSH_AUTH_SOCK",
      ].every(isRepositoryCredentialName),
    ).toBe(true);
    expect(isRepositoryCredentialName("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("extracts repository credentials from dotenv input", () => {
    expect(
      repositoryCredentialNamesInEnvironmentFile(
        "ANTHROPIC_API_KEY=model-only\nexport GITHUB_TOKEN=forbidden\n",
      ),
    ).toEqual(["GITHUB_TOKEN"]);
  });

  it("detects protected Git configuration and authorization material", () => {
    expect(containsProtectedWorkerMaterial("credential.helper = store")).toBe(
      true,
    );
    expect(
      containsProtectedWorkerMaterial("Authorization: Bearer secret-value"),
    ).toBe(true);
  });
});
