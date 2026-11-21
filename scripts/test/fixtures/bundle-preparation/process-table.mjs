/** The output buffer of spawnSync when the caller names none. */
const DEFAULT_BUFFER = 1024 * 1024;

/**
 * A process table reader that answers `ps -axww -o pid=,command=` with `rows`, each `[pid, command]`, and fails as spawnSync does
 * when the output exceeds the buffer of the call. It records the calls.
 */
export function table(rows, calls = []) {
  return (file, args, options) => {
    calls.push([file, args]);
    const stdout = rows.map(([pid, command]) => `${String(pid).padStart(5)} ${command}\n`).join("");
    const limit = options?.maxBuffer ?? DEFAULT_BUFFER;
    if (Buffer.byteLength(stdout) > limit) {
      return { status: null, stdout: stdout.slice(0, limit), stderr: "", error: Object.assign(new Error(`spawnSync ${file} ENOBUFS`), { code: "ENOBUFS" }) };
    }
    return { status: 0, stdout, stderr: "" };
  };
}
