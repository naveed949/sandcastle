export interface AgentStreamEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

type Listener = (runId: number, event: AgentStreamEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(runId: number, event: AgentStreamEvent): void {
    for (const listener of this.listeners) {
      listener(runId, event);
    }
  }
}
