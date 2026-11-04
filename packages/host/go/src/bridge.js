// Runs when each document of a native web view that the application created starts.
(() => {
  const epoch = `${Date.now()}-${Math.random()}`;
  const pending = new Map();
  const listeners = new Map();
  let serial = 0;
  window.__soksakNative = {
    call(method, args) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        try {
          window.webkit.messageHandlers.soksak.postMessage(JSON.stringify({ epoch, id, method, args }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return Promise.resolve(() => listeners.get(name)?.delete(fn));
    },
    receive(message) {
      if (message.event) {
        // default: no listener is registered for that event, so there is nobody to notify.
        for (const fn of listeners.get(message.event) ?? []) fn(message.data);
        return;
      }
      if (message.epoch !== epoch) return;
      const reply = pending.get(message.id);
      if (!reply) return;
      pending.delete(message.id);
      if (message.error) reply.reject(new Error(message.error));
      else reply.resolve(message.result);
    },
  };
})();
