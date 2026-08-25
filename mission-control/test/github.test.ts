import { describe, expect, it } from "vitest";
import {
  parseBlockedByFromBody,
  parseIssueUrl,
  parseRepositorySlug,
} from "../server/github.js";

describe("parseRepositorySlug", () => {
  it.each([
    ["acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets.git/", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
  ])("normalizes %s", (input, expected) => {
    expect(parseRepositorySlug(input)).toBe(expected);
  });

  it("rejects repositories outside GitHub", () => {
    expect(() =>
      parseRepositorySlug("https://example.com/acme/widgets"),
    ).toThrow("Not a GitHub repository");
  });
});

describe("parseIssueUrl", () => {
  it("parses owner/repo/number", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/42")).toEqual({
      owner: "o",
      repo: "r",
      issueNumber: 42,
    });
  });

  it("throws on non-issue urls", () => {
    expect(() => parseIssueUrl("https://example.com")).toThrow();
  });
});

describe("parseBlockedByFromBody", () => {
  it("finds issue refs under the Blocked by heading", () => {
    const body = "## What to build\nstuff\n\n## Blocked by\n- #12\n- #13\n";
    expect(parseBlockedByFromBody(body)).toEqual([12, 13]);
  });

  it("returns empty when no section", () => {
    expect(parseBlockedByFromBody("no blockers here #99")).toEqual([]);
  });
});
