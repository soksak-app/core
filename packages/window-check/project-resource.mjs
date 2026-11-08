import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Session cleanups run in reverse registration order: detach every live owner
// and flush its state before deleting the project folder.
export function temporaryProject(s, prefix) {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  const root = realpathSync(folder);
  s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
  s.cleanup(async () => {
    for (const listed of await s.get("core.projects")) {
      if (listed.root === folder || listed.root === root) await s.run("core.project.close", { id: listed.id });
    }
    await s.run("core.projects.flush");
  });
  return folder;
}

export function ownProjectWindow(session, child) {
  let closed = false;
  const close = async () => {
    if (closed) return;
    await child.close();
    closed = true;
  };
  session.cleanup(close);
  return close;
}
