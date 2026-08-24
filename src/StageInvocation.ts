/** Raised when the operator aborts a stage invocation. */
export class StageCancellationError extends Error {
  readonly code: string;

  constructor(code: string, reason: unknown) {
    super(
      reason instanceof Error
        ? reason.message
        : "The stage was cancelled by the operator.",
    );
    this.name = "StageCancellationError";
    this.code = code;
  }
}

/** Raised when a stage exceeds its configured time budget. */
export class StageTimeoutError extends Error {
  readonly code: string;

  constructor(code: string, timeoutMs: number) {
    super(`The stage exceeded ${timeoutMs}ms.`);
    this.name = "StageTimeoutError";
    this.code = code;
  }
}

export interface StageInvocationInput<T> {
  /** The agent boundary to invoke with the expanded prompt. */
  readonly invoke: (input: {
    readonly prompt: string;
    readonly signal: AbortSignal;
  }) => Promise<T>;
  readonly prompt: string;
  /** Operator signal merged into the stage-owned controller. */
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  /** Machine-readable code retained on cancelled records. */
  readonly cancelCode: string;
  /** Machine-readable code retained on timed-out records. */
  readonly timeoutCode: string;
}

/**
 * Run one agent-boundary invocation under stage-owned cancellation and
 * timeout controls. The operator signal and the deadline both abort the
 * child through a single AbortController.
 */
export const invokeStage = async <T>(
  input: StageInvocationInput<T>,
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  let controlError: StageCancellationError | StageTimeoutError | undefined;
  const abortWith = (
    error: StageCancellationError | StageTimeoutError,
    reason: unknown = error,
  ): StageCancellationError | StageTimeoutError => {
    if (controlError === undefined) {
      controlError = error;
      controller.abort(reason);
    }
    return controlError;
  };
  const cancellation = new Promise<never>((_, reject) => {
    if (input.signal?.aborted) {
      reject(
        abortWith(
          new StageCancellationError(input.cancelCode, input.signal.reason),
        ),
      );
      return;
    }
    if (input.signal !== undefined) {
      const onAbort = () => {
        reject(
          abortWith(
            new StageCancellationError(input.cancelCode, input.signal!.reason),
            input.signal!.reason,
          ),
        );
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        input.signal!.removeEventListener("abort", onAbort);
    }
  });
  if (input.signal?.aborted) {
    throw new StageCancellationError(input.cancelCode, input.signal.reason);
  }
  const invocation = input
    .invoke({
      prompt: input.prompt,
      signal: controller.signal,
    })
    .then(
      (result) => {
        if (controlError !== undefined) throw controlError;
        return result;
      },
      (error) => {
        if (controlError !== undefined) throw controlError;
        throw error;
      },
    );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        abortWith(new StageTimeoutError(input.timeoutCode, input.timeoutMs)),
      );
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([invocation, cancellation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
    void invocation.catch(() => undefined);
  }
};

export interface StageFailureClassification {
  readonly code: string;
  readonly message: string;
  /** Resumable stages may resume the same attempt; terminal ones may not. */
  readonly recovery: "resumable" | "terminal";
  readonly status: "failed" | "cancelled" | "timed_out";
}

export interface StageFailureCodes {
  readonly cancelCode: string;
  readonly timeoutCode: string;
  /** Code used when structured output fails schema validation. */
  readonly invalidOutputCode: string;
  /** Code used for failures carrying no recognizable code of their own. */
  readonly unknownCode: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Classify a stage failure into record fields. Cancellation, timeout, and
 * malformed structured output are resumable; every other failure is
 * terminal for this invocation.
 */
export const classifyStageFailure = (
  error: unknown,
  codes: StageFailureCodes,
): StageFailureClassification => {
  if (error instanceof StageCancellationError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "resumable",
      status: "cancelled",
    };
  }
  if (error instanceof StageTimeoutError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "resumable",
      status: "timed_out",
    };
  }
  // Structured-output errors are identified by name because importing the
  // class here would create a module cycle; the recovery surface is defined
  // by ADR-0010 (resume the session with feedback).
  if (error instanceof Error && error.name === "StructuredOutputError") {
    return {
      code: codes.invalidOutputCode,
      message: error.message,
      recovery: "resumable",
      status: "failed",
    };
  }
  if (isRecord(error) && typeof error.code === "string") {
    return {
      code: error.code,
      message: errorMessage(error),
      recovery: "terminal",
      status: "failed",
    };
  }
  return {
    code: codes.unknownCode,
    message: errorMessage(error),
    recovery: "terminal",
    status: "failed",
  };
};
