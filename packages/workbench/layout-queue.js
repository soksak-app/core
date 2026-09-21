// Run one presentation and keep only the newest presentation waiting behind it.
// SoksakView guarantees that an older pending draw cannot draw a newer layout.
// Replacing that pending work is therefore part of the contract, but it must be
// observable instead of becoming an unreported promise or a silent return.
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
        item.reject(error);
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
      const result = new Promise((resolve, reject) => {
        const item = { work, resolve, reject };
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
    wait: () => latest,
  };
}
