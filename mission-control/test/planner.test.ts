import { describe, expect, it } from "vitest";
import { topologicalOrder } from "../server/planner.js";

describe("topologicalOrder", () => {
  it("orders blockers before dependents", () => {
    const ordered = topologicalOrder([
      { ghIssueNumber: 3, title: "c", blockers: [1, 2] },
      { ghIssueNumber: 1, title: "a", blockers: [] },
      { ghIssueNumber: 2, title: "b", blockers: [1] },
    ]);
    expect(ordered.map((t) => t.ghIssueNumber)).toEqual([1, 2, 3]);
  });

  it("ignores blockers outside the PRD", () => {
    const ordered = topologicalOrder([
      { ghIssueNumber: 5, title: "x", blockers: [999] },
    ]);
    expect(ordered.map((t) => t.ghIssueNumber)).toEqual([5]);
  });

  it("throws on cycles", () => {
    expect(() =>
      topologicalOrder([
        { ghIssueNumber: 1, title: "a", blockers: [2] },
        { ghIssueNumber: 2, title: "b", blockers: [1] },
      ]),
    ).toThrow(/cycle/);
  });
});
