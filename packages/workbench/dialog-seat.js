// The seat of the dialog of the window in the plane (docs/spec/plugins.md#dialogs): the plane draws it in each draw, so the placement
// that follows holds the dialog surface at the content of the window, and the first draw of a dialog mounts its view.
import { clearSlotSurface, setSlotSurface } from "./compositor.js";
import { mountSurface } from "./surface-modules.js";
import { failDialog, openDialogEntry } from "./dialogs.js";

/**
 * Draws the seat of the open dialog in the container of the plane, and removes the seat of a dialog that ended. The seat covers
 * the content of the window below the title bar, whose bottom is top (CSS pixels of the window). The first draw of a dialog mounts
 * its view; a view that fails ends the dialog, and the open call fails with the error, which the error display shows.
 */
export function drawDialogSeat(container, top) {
  const open = openDialogEntry();
  for (const seat of container.querySelectorAll(":scope > .dialog-seat")) {
    if (seat === open?.slot) continue;
    clearSlotSurface(seat);
    seat.remove();
  }
  if (open === null) return;
  const entry = open;
  entry.slot.style.top = `${top}px`;
  if (entry.slot.parentElement !== container) container.append(entry.slot);
  setSlotSurface(entry.slot, entry.surface);
  if (entry.mounted) return;
  entry.mounted = true;
  const fail = (text) => failDialog(entry, text);
  mountSurface(entry.slot, entry.surface, {
    onState: (state) => {
      // default: an error that is not an Error is shown as its text.
      if (state.phase === "error") fail(state.error?.message ?? String(state.error));
    },
  }).catch((error) => fail(error.message));
}
