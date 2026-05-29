import { StructuredOutputError } from "@ai-hero/sandcastle";

export const buildRetryFeedback = (
  error: StructuredOutputError,
  attempt: number,
  maxAttempts: number,
): string => {
  const raw =
    error.rawMatched === undefined
      ? "(no matching tag was emitted)"
      : error.rawMatched;
  const cause =
    error.cause === undefined
      ? "(no parser detail)"
      : JSON.stringify(error.cause, null, 2);

  return `Your previous response did not produce valid structured output.

Attempt ${attempt} of ${maxAttempts}.

Problem:
${error.message}

Parser detail:
${cause}

Previous matched output:
${raw}

Emit only a corrected <${error.tag}> block. Do not change files or run commands.`;
};
