// The last pointer sequence that the main document received. If the pressed element is replaced between a press and a release, the browser creates no click,
// so to identify a lost click it records the target names of the press, the release, and the click, and whether the pressed element was still in the document at the release.
import { focusName } from "./focus-state.js";

/**
 * Records pointerdown, pointerup, and click of document and calls changed on each change. The return value is a function that returns the current record,
 * which is { sequence, down, up, pressedConnected, click }. sequence grows on each press and the other fields start anew.
 */
export function trackPointer(document, changed) {
  let sequence = 0;
  let pressed = null;
  let record = { sequence, down: null, up: null, pressedConnected: null, click: null };
  document.addEventListener("pointerdown", (event) => {
    sequence++;
    pressed = event.composedPath()[0];
    record = { sequence, down: focusName(event), up: null, pressedConnected: null, click: null };
    changed();
  }, true);
  document.addEventListener("pointerup", (event) => {
    record = { ...record, up: focusName(event), pressedConnected: pressed ? pressed.isConnected : null };
    changed();
  }, true);
  document.addEventListener("click", (event) => {
    record = { ...record, click: focusName(event) };
    changed();
  }, true);
  return () => record;
}
