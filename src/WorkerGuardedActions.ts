export interface WorkerGuardedActionEvent {
  readonly action: "claim" | "verification" | "publication";
  readonly executionIdentity: string;
  readonly evidence: readonly string[];
  readonly timestamp?: string;
}

/** Observer invoked only after a guarded worker action is durably retained. */
export interface WorkerGuardedActionRecorder {
  readonly record: (event: WorkerGuardedActionEvent) => Promise<void>;
}
