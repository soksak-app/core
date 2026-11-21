// The setup parts of this window (setup-parts.js) and their exposed entries: the core.setup status and the core.setup.check and
// core.setup.install and core.setup.change commands (docs/spec/settings.md#agents). The settings window draws the agent group from the same parts.
import { host } from "@soksak/runtime";
import { registry } from "./exposure.js";
import { createSetupParts } from "./setup-parts.js";

const listeners = new Set();
let display = null;

export const setupParts = createSetupParts({
  host,
  changed: () => { for (const fn of listeners) fn(); },
  failed: (text) => {
    // A read or install runs only after the start installed the entries, which gives the error display.
    if (!display) throw new Error(`the setup error display is not installed: ${text}`);
    display(text);
  },
});

/**
 * Registers the setup entries, follows the host events that read the parts again, and calls changed when the parts change.
 * showError is the error display of the page.
 */
export function installSetupExposure({ showError, changed }) {
  display = showError;
  listeners.add(changed);
  registry.status("core.setup", () => setupParts.status(), (fn) => {
    const send = () => fn(setupParts.status());
    listeners.add(send);
    return () => listeners.delete(send);
  });
  registry.command("core.setup.check", () => setupParts.read());
  registry.command("core.setup.install", ({ parts }) => setupParts.install(parts));
  registry.command("core.setup.change", (params) => setupParts.change(params));
  setupParts.follow();
}
