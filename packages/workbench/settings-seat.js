// The seat of the settings surface in the plane (docs/spec/native-surfaces.md#settings-seat): the plane draws it in each draw at the place
// that the modal document of the settings window reported, so the placement that follows holds the settings surface in the pane, and the
// first draw of a settings surface mounts its view.
import { clearSlotSurface, setSlotSurface } from "./compositor.js";
import { mountSurface } from "./surface-modules.js";
import { failSettingsView, openSettingsEntry, settingsSeat } from "./settings-view.js";

// A seat shows while any part of its frame lies inside the clip (docs/spec/native-surfaces.md#settings-seat).
const shows = ({ frame, clip }) => Math.min(frame.x + frame.w, clip.x + clip.w) > Math.max(frame.x, clip.x)
  && Math.min(frame.y + frame.h, clip.y + clip.h) > Math.max(frame.y, clip.y);

/**
 * Draws the seat of the open settings surface in the container of the plane at its measured place, and removes the seat of a surface that
 * ended. The slot is hidden while the seat is not measured or no part of it shows. The first draw mounts the view; a view that fails ends
 * the surface until its page is shown again, and the error display shows the error at settings <plugin>.
 */
export function drawSettingsSeat(container) {
  const open = openSettingsEntry();
  for (const seat of container.querySelectorAll(":scope > .settings-seat")) {
    if (seat === open?.slot) continue;
    clearSlotSurface(seat);
    seat.remove();
  }
  if (open === null) return;
  const entry = open;
  const seat = settingsSeat();
  entry.seat = seat;
  if (seat === null) {
    // A seat that the modal document has not reported has no place, so its slot stays hidden and carries no clip.
    entry.slot.hidden = true;
    delete entry.slot.dataset.nativeClip;
  } else {
    const { frame, clip } = seat;
    Object.assign(entry.slot.style, { left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.w}px`, height: `${frame.h}px` });
    entry.slot.hidden = !shows(seat);
    entry.slot.dataset.nativeClip = JSON.stringify(clip);
  }
  if (entry.slot.parentElement !== container) container.append(entry.slot);
  setSlotSurface(entry.slot, entry.surface);
  if (entry.mounted) return;
  entry.mounted = true;
  const fail = (text) => failSettingsView(entry, text);
  mountSurface(entry.slot, entry.surface, {
    onState: (state) => {
      // default: an error that is not an Error is shown as its text.
      if (state.phase === "error") fail(state.error?.message ?? String(state.error));
    },
  }).catch((error) => fail(error.message));
}
