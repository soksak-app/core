/** Reads the current stored registry at the window consumer boundary. */
export function projectRecords(value, file) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.format !== 1) {
    throw new TypeError(`${file}: expected projects format 1, found format ${value?.format ?? "absent"}`);
  }
  if (!Array.isArray(value.projects)) {
    throw new TypeError(`${file}: projects must be an array`);
  }
  return value.projects;
}
