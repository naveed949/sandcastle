import { describe, expect, it } from "vitest";
import { makeSpinnerCollapsingEmitter } from "../server/workspace.js";

describe("makeSpinnerCollapsingEmitter", () => {
  it("collapses consecutive spinner frames to one line", () => {
    const lines: string[] = [];
    const emit = makeSpinnerCollapsingEmitter((_s, l) => lines.push(l));
    emit(
      "stdout",
      Buffer.from("◐  Building Docker image 'sandcastle:repo'...\n"),
    );
    emit(
      "stdout",
      Buffer.from("◓  Building Docker image 'sandcastle:repo'...\n"),
    );
    emit(
      "stdout",
      Buffer.from("◑  Building Docker image 'sandcastle:repo'...\n"),
    );
    expect(lines).toEqual(["Building Docker image 'sandcastle:repo'..."]);
  });

  it("keeps distinct lines", () => {
    const lines: string[] = [];
    const emit = makeSpinnerCollapsingEmitter((_s, l) => lines.push(l));
    emit("stderr", Buffer.from("ESM Build start\nDTS Build start\n"));
    expect(lines).toEqual(["ESM Build start", "DTS Build start"]);
  });
});
