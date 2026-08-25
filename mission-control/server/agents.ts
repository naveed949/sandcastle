import type { Db } from "./db.js";

/**
 * Parses run.ts output lines to track per-agent lifecycle:
 *   "[Planner] Started on branch tmp/prd-v1"   → new agent card
 *   "tail -f .sandcastle/logs/<agent>.log"     → attach log file to latest agent
 */
export function trackAgent(db: Db, runId: number, line: string): void {
  const start = line.match(
    /^\[([^\]]+?)\s*#?(\d*)\]\s*Started on branch (\S+)/,
  );
  if (start) {
    const phase = start[1]; // Planner | Implementer | Reviewer | Merger
    const name = start[2] ? `${start[1]} #${start[2]}` : start[1];
    // Phase change heuristic: agents from other phases that are still marked
    // running have completed their turn (run.ts proceeds phase by phase).
    for (const agent of db.listAgents(runId)) {
      const agentPhase = agent.name.split(" #")[0];
      if (agent.status === "running" && agentPhase !== phase) {
        db.setAgentStatus(agent.id, "done");
      }
    }
    db.addAgent(runId, name, start[3]);
    return;
  }
  const tail = line.match(/^tail -f\s+(\S+\.log)\s*$/);
  if (tail) {
    const latest = db.latestAgent(runId);
    if (latest && !latest.log_file) {
      db.setAgentLogFile(latest.id, tail[1]);
    }
    return;
  }
  if (
    /^Branches merged\.?$/.test(line.trim()) ||
    /^All done\.?$/.test(line.trim())
  ) {
    for (const agent of db.listAgents(runId)) {
      if (agent.status === "running") db.setAgentStatus(agent.id, "done");
    }
  }
}
