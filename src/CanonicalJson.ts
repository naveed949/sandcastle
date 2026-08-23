import { createHash } from "node:crypto";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Serialize JSON-shaped data with stable object-key ordering. */
export const canonicalJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot hash a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Cannot hash an unsupported value");
};

/** Return a SHA-256 digest of canonical JSON-shaped data. */
export const canonicalJsonDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Compare JSON-shaped data after stable serialization. */
export const sameCanonicalJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);
