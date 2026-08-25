import { describe, expect, it } from "vitest";
import { normalizeRepoUrl } from "../server/workspace.js";

describe("normalizeRepoUrl", () => {
  it("expands owner/repo shorthand to https", () => {
    expect(normalizeRepoUrl("naveed949/sandcastle")).toBe(
      "https://github.com/naveed949/sandcastle.git",
    );
  });

  it("passes through full urls and ssh remotes", () => {
    expect(normalizeRepoUrl("https://github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(normalizeRepoUrl("git@github.com:o/r.git")).toBe(
      "git@github.com:o/r.git",
    );
  });
});
