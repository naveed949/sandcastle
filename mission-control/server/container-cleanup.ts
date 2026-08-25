import { execFile } from "node:child_process";
import path from "node:path";

import { projectWorkspace } from "./workspace.js";

export type ExecFile = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

const exec: ExecFile = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString() });
    });
  });

/**
 * Force-removes Sandcastle containers mounted from this project's workspace.
 * Docker owns these processes, so killing run.ts does not remove them.
 */
export async function removeProjectContainers(
  dataDir: string,
  projectId: number,
  run: ExecFile = exec,
): Promise<void> {
  const workspace = path.resolve(projectWorkspace(dataDir, projectId));
  const workspacePrefix = `${workspace}${path.sep}`;

  try {
    const { stdout } = await run("docker", [
      "ps",
      "--filter",
      "name=sandcastle-",
      "--format",
      "{{.Names}}",
    ]);

    for (const name of stdout.split("\n").filter(Boolean)) {
      try {
        const { stdout: mounts } = await run("docker", [
          "inspect",
          "--format",
          "{{range .Mounts}}{{println .Source}}{{end}}",
          name,
        ]);
        const belongsToProject = mounts
          .split("\n")
          .some(
            (source) =>
              source === workspace || source.startsWith(workspacePrefix),
          );
        if (belongsToProject) {
          await run("docker", ["rm", "-f", name]);
          console.log(`[project ${projectId}] removed container ${name}`);
        }
      } catch {
        // The container may have exited between listing and inspection/removal.
      }
    }
  } catch (error) {
    console.error(`[project ${projectId}] container cleanup failed:`, error);
  }
}
