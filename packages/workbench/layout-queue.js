// Runs presentations one at a time, and after that lets only the newest layout wait.
// One presentation takes at least one screen frame, so pointer input can arrive faster than presentations.
// If every waiting layout ran in turn, the screen would lag behind the pointer by the number of queued layouts.
// The newest layout holds all earlier input, so it replaces the waiting earlier layout, and the
// preparation and drawing of that layout are not run. The replacing layout is reported as superseded.
//
// A failed layout is received and reported by failed, and the reply of run is fulfilled with { status: "failed" }. The requester that received the failure is the queue,
// so the side that scheduled or awaited the layout does not receive the same failure again as a rejection (docs/spec/hosts.md#application-log).
export function createLayoutQueue({ failed, superseded }) {
  let active = null;
  let pending = null;
  let latest = Promise.resolve();

  function start(item) {
    active = item;
    Promise.resolve()
      .then(item.work)
      .then(item.resolve, (error) => {
        failed(error);
        item.resolve({ status: "failed" });
      })
      .finally(() => {
        active = null;
        if (pending) {
          const next = pending;
          pending = null;
          start(next);
        }
      });
  }

  return {
    run(work) {
      const result = new Promise((resolve) => {
        const item = { work, resolve };
        if (pending) {
          superseded(pending.work);
          pending.resolve({ status: "superseded" });
        }
        pending = item;
        if (!active) {
          const next = pending;
          pending = null;
          start(next);
        }
      });
      latest = result;
      return latest;
    },
    /**
     * Waits until the newest layout ends, and returns true if that layout ran to the end and false if it failed. If a newer layout is scheduled
     * during the wait, it waits for that layout again. A superseded layout ends without drawing, so stopping at its end would leave in the document the slot
     * that layout was going to clear. The failure was already reported by failed (docs/spec/hosts.md#application-log).
     */
    async wait() {
      for (;;) {
        const awaited = latest;
        const outcome = await awaited;
        // default: the reply of a layout that ran to the end is the return value of that work, and drawPrepared returns no value.
        if (awaited === latest) return outcome?.status !== "failed";
      }
    },
  };
}

/**
 * Draws one layout. After the native preparation reply (prepare) confirms the start and the application of the transaction, it draws the DOM (draw). If the preparation were confirmed
 * by the start of the request alone, the new DOM would be shown first under the earlier native region. The drawing runs in the next task after the preparation
 * (frame(work), nextTask). The microtask checkpoint where the preparation reply was fulfilled can belong to a ResizeObserver callback, and
 * a task runs outside the observation round (F43). After drawing, it waits for the host presentation (presented) so that the next layout cannot
 * replace the DOM first. If current() differs from epoch while preparing or while waiting to draw, it does not draw.
 */
export async function drawPrepared({ epoch, current, prepare, draw, frame, presented }) {
  if (epoch !== current()) return;
  await prepare();
  if (epoch !== current()) return;
  let drawn = false;
  await frame(() => {
    if (epoch !== current()) return;
    draw();
    drawn = true;
  });
  if (!drawn) return;
  await presented();
}

/**
 * Runs work in the next task and ends. If work throws, it fails with that error. A preparation reply can be fulfilled at any microtask
 * checkpoint, and drawing at the checkpoint of a ResizeObserver callback changes the size of an element that the observation round already delivered, so WebKit raises a
 * loop error (F43). A task does not run between a rendering update and its observation round. Unlike an animation frame, it does not wait for a screen update,
 * so the rendering update that the host causes while it waits for the presentation carries this drawing (F92).
 */
export function nextTask(work) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      try {
        work();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    channel.port2.postMessage(null);
  });
}
