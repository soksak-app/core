// The activation of the image region of the raster probe for the IME checks of e2e/activation, which run only in runs the user
// approved because they take the focus of the user (scripts/check-app-tests.mjs).
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { imageFocused, imagePoint } from "../input-probe.mjs";

/**
 * Gives the native keyboard of the active key window to the image region of the raster probe `surface` as a person does: the check
 * asks the system to activate the application, as a person does by choosing it, and waits until the window is really active; the
 * window moves away from the pointer, a move over the region makes the window key and a press focuses it, and the probe focuses its
 * region. The input methods of the system serve only the key window of the really active application, and `activate: true` only
 * emulates the activation (docs/spec/exposure.md#virtual-key-window), so this tier, which the person approved to take the focus,
 * asks LaunchServices for the activation (`open -a` of the bundle of the checked executable).
 */
export async function focusImageActive(s, surface) {
  await activateApplication(s);
  await s.keepPointerOutside();
  const point = await imagePoint(s, surface);
  await s.pointer(point.x, point.y, "move", { activate: true });
  await s.click(point.x, point.y);
  await s.run("rasterprobe.focus", {}, surface);
  await s.until("host.window", (host) => host.active === true && host.key === true && imageFocused(host, surface)
    && host.responder?.surface === surface, "the image region did not become the focused view of the active key window");
  await s.until("rasterprobe.input", (input) => input.focused, "the image region did not report its focus", { surface });
}

/**
 * Asks LaunchServices to activate the application of the session (`open -a` of the bundle of the checked executable), as a person
 * does by choosing it, and waits until its window is really active. `activate: true` of a pointer only emulates the activation
 * (docs/spec/exposure.md#virtual-key-window), and the input methods of the system serve only the really active application.
 */
export async function activateApplication(s) {
  const bundle = dirname(dirname(dirname(realpathSync(s.app.binary))));
  await promisify(execFile)("open", ["-a", bundle]);
  await s.until("host.window", (host) => host.active === true, "the application did not become active after its activation");
}
