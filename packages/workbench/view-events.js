// The page side of the event subscriptions of a view (docs/spec/native-surfaces.md#view-surfaces). A subscription call of the view
// registers one listener in the page, and each event that the listener receives is pushed to the view as a host message
// {sok: 1, event, data} through push. The subscriptions end when the surface closes.

/**
 * Creates the subscriptions of one view surface.
 *
 *     native      native(name, fn): the surface event of the name, as runtime.native.on; resolves with the off function
 *     sidecar     the sidecar of the surface with on(id, fn) and onFailure(id, fn), as runtime.sidecar() has; each resolves with the off function
 *     textSize    textSize(fn): registers fn(factor) for the changes of the text scale of the surface, as runtime.textSize.on does;
 *                 resolves with the off function
 *     settings    settings(fn): registers fn(values) for the changes of the settings of the plugin, as runtime.settings.on does;
 *                 resolves with the off function
 *     logLevels   {read(), on(fn)}: read() returns the stored levels of a record of the plugin, and on(fn) registers fn for each
 *                 change of the policy in force; on resolves with the off function
 *     status      status(name, fn): follows the value of the status name, as the registry observe does; fn(value) receives each value
 *                 and the function returns the unsubscribe function, which it calls at the end of the watch
 *     push        push(event, data): posts {event, data} to the view through viewEvent; rejects when the host refuses it
 *     report      report(text): receives the text of a push that the host refused
 *
 * Returns {native(name), sidecarMessage(id), sidecarFailure(id), textSize(), settings(), logLevels(), statusWatch(name),
 * statusUnwatch(name), close()}. A subscription call resolves with null, and a second call for the same name or id registers nothing.
 * An unwatch of a name that is not watched ends nothing and resolves with null.
 */
export function createViewSubscriptions({ native, sidecar, textSize, settings, logLevels, status, push, report }) {
  if (typeof push !== "function" || typeof report !== "function") {
    throw new TypeError("createViewSubscriptions requires the push and report functions");
  }
  // The registration of each key and its off function, by key. A key is native:<name>, sidecar.message:<id>, sidecar.failure:<id>,
  // or status:<name>.
  const registered = new Map();
  // Set by close: an event that arrives after the surface closed is pushed to no view.
  let closed = false;
  const forward = (event, data) => {
    if (closed) return;
    push(event, data).then(undefined, (error) => {
      // default: a refusal that is not an Error carries its value as the text.
      report(`view event ${event}: ${error?.message ?? error}`);
    });
  };
  const subscribe = (key, register) => {
    if (closed) return Promise.reject(new Error("view subscriptions are closed"));
    if (registered.has(key)) return Promise.resolve(null);
    const pending = register().then((off) => {
      registered.set(key, off);
      return null;
    });
    // A refused registration is forgotten, so that a later call for the key registers again.
    pending.catch(() => registered.delete(key));
    return pending;
  };
  return {
    native(name) {
      return subscribe(`native:${name}`, () => {
        if (typeof native !== "function") throw new TypeError("view subscriptions have no surface event");
        return native(name, (data) => forward(name, data));
      });
    },
    sidecarMessage(id) {
      return subscribe(`sidecar.message:${id}`, () => sidecar.on(id, (body) => forward("sidecar.message", { id, body })));
    },
    sidecarFailure(id) {
      return subscribe(`sidecar.failure:${id}`, () => sidecar.onFailure(id, (reason) => forward("sidecar.failure", { id, reason })));
    },
    textSize() {
      return subscribe("textSize", () => textSize((factor) => forward("textSize", factor)));
    },
    settings() {
      return subscribe("settings", () => settings((values) => forward("settings", values)));
    },
    // The stored levels are read again at each change of the policy, and only levels that differ from the last are pushed.
    logLevels() {
      return subscribe("log.levels", () => {
        let last = logLevels.read().join();
        return logLevels.on(() => {
          const next = logLevels.read();
          if (next.join() === last) return;
          last = next.join();
          forward("log.levels", next);
        });
      });
    },
    // A status is watched once per name: the value of the status is pushed as the event status with {name, value}.
    statusWatch(name) {
      // A refusal of the page is a rejection, so the executor carries a synchronous throw of the observation into it.
      return subscribe(`status:${name}`, () => new Promise((resolve) => {
        resolve(status(name, (value) => forward("status", { name, value })));
      }));
    },
    statusUnwatch(name) {
      const key = `status:${name}`;
      const off = registered.get(key);
      if (off === undefined) return Promise.resolve(null);
      registered.delete(key);
      return Promise.resolve(off()).then(() => null);
    },
    async close() {
      closed = true;
      const offs = [...registered.values()];
      registered.clear();
      for (const off of offs) await off();
    },
  };
}
