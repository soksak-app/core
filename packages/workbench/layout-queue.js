// Run every presentation in arrival order. A layout is a user-visible state and
// must not be replaced by a newer state before its DOM/native transaction runs.
export function createLayoutQueue({ failed }) {
  let active = null;
  const pending = [];
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
        if (pending.length > 0) {
          const next = pending.shift();
          start(next);
        }
      });
  }

  return {
    run(work) {
      const result = new Promise((resolve, reject) => {
        const item = { work, resolve, reject };
        pending.push(item);
        if (!active) {
          const next = pending.shift();
          start(next);
        }
      });
      latest = result;
      return latest;
    },
    wait: () => latest,
  };
}
