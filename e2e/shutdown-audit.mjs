import { readEventErrors } from "@soksak/window-check/event-log.mjs";

/** Rejects application errors written after the shutdown check's event-log offset. */
export function auditShutdownErrors({ appName, configDir, offsets, boot }) {
  const { errors } = readEventErrors(configDir, offsets, boot);
  if (errors.length > 0) {
    const noun = errors.length === 1 ? "error" : "errors";
    throw new Error(`${appName}: the application logged ${errors.length} ${noun} during shutdown:\n${errors.join("\n")}`);
  }
  return errors;
}
