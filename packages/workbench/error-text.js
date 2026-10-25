/**
 * Formats a rejected value for a user-visible error or application record. Include code and data when present, and serialize
 * objects without a message so a report never degrades to `[object Object]` (docs/spec/logging.md).
 */
export function errorText(error) {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return String(error);
  if (typeof error.message !== "string") return JSON.stringify(error);
  const extra = [];
  if (error.code !== undefined) extra.push(`code ${error.code}`);
  if (error.data !== undefined) extra.push(`data ${JSON.stringify(error.data)}`);
  return extra.length === 0 ? error.message : `${error.message} (${extra.join(", ")})`;
}
