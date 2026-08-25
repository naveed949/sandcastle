export interface PlannedTicket {
  ghIssueNumber: number;
  title: string;
  blockers: number[];
}

/**
 * Returns tickets in dependency order (blockers before dependents).
 * Throws on cycles or unknown blockers.
 */
export function topologicalOrder(tickets: PlannedTicket[]): PlannedTicket[] {
  const byNumber = new Map(tickets.map((t) => [t.ghIssueNumber, t]));
  const ordered: PlannedTicket[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (ticket: PlannedTicket): void => {
    if (visited.has(ticket.ghIssueNumber)) return;
    if (visiting.has(ticket.ghIssueNumber)) {
      throw new Error(
        `Dependency cycle involving issue #${ticket.ghIssueNumber}`,
      );
    }
    visiting.add(ticket.ghIssueNumber);
    for (const blocker of ticket.blockers) {
      const dep = byNumber.get(blocker);
      if (!dep) continue; // blocker outside this PRD — ignore for ordering
      visit(dep);
    }
    visiting.delete(ticket.ghIssueNumber);
    visited.add(ticket.ghIssueNumber);
    ordered.push(ticket);
  };

  for (const t of tickets) visit(t);
  return ordered;
}

export function frontier(
  tickets: PlannedTicket[],
  doneNumbers: Set<number>,
): PlannedTicket[] {
  return tickets.filter((t) =>
    t.blockers
      .filter((b) => tickets.some((x) => x.ghIssueNumber === b))
      .every((b) => doneNumbers.has(b)),
  );
}
