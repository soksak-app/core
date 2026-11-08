// The activation of the image region of the raster probe for the IME checks of e2e/activation, which run only in runs the user
// approved because they take the focus of the user (scripts/check-app-tests.mjs).
import { imageFocused, imagePoint } from "../input-probe.mjs";

/**
 * Gives the native keyboard of the active key window to the image region of the raster probe `surface` as a person does: the window
 * moves away from the pointer, the check activates the application with a move over the region and presses it, and the probe focuses
 * its region. The input methods of the system serve only the key window of the active application
 * (docs/spec/exposure.md#virtual-key-window).
 */
export async function focusImageActive(s, surface) {
  await s.keepPointerOutside();
  const point = await imagePoint(s, surface);
  await s.pointer(point.x, point.y, "move", { activate: true });
  await s.click(point.x, point.y);
  await s.run("rasterprobe.focus", {}, surface);
  await s.until("host.window", (host) => host.active === true && host.key === true && imageFocused(host, surface)
    && host.responder?.surface === surface, "the image region did not become the focused view of the active key window");
  await s.until("rasterprobe.input", (input) => input.focused, "the image region did not report its focus", { surface });
}
