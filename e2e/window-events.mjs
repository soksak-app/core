// The events of a window that a check opens and closes (docs/spec/logging.md#entrances).
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { reading } from "./fixture.mjs";

/** The records that openAndCloseWindow reads. */
export const WINDOW_EVENT_READS = Object.freeze(["host.window.event"]);

/**
 * Opens a window with core.window.new in the application of `s`, waits until it drew its frames, closes it and returns the event
 * line of its close. A check opens its window behind the windows of other applications, where a covered window is the normal case,
 * so the window is judged by states that other windows do not change: its page is ready and it presents its layout
 * (docs/spec/hosts.md#launch-activation). Its occlusion is not one of them: a window
 * that other windows cover completely when it opens reports no occlusion change.
 */
export async function openAndCloseWindow(s) {
  const { configDir } = s.app;
  const offsets = currentEventOffsets(configDir);
  await s.run("core.window.new");
  const list = await s.windows(2, "the new window did not open");
  const child = s.on(list.find((w) => w.window !== s.window).window);
  await child.presented();
  await child.close();
  return untilEventLine(configDir, offsets,
    (line) => line.startsWith("info host host.window.event:") && line.includes('"kind":"closed"'), 30000,
    reading(s.app, WINDOW_EVENT_READS));
}

