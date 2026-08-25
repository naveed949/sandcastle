import { readFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";

describe("bundled Sandcastle template", () => {
  it("compiles when the submitted repository is CommonJS", async () => {
    const source = await readFile(
      path.join(process.cwd(), "sandcastle-template", "run.ts"),
      "utf8",
    );

    await expect(
      transform(source, {
        format: "cjs",
        loader: "ts",
        target: "node22",
      }),
    ).resolves.toBeDefined();
  });
});
