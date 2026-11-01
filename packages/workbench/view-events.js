// The page side of the event subscriptions of a view (docs/spec/native-surfaces.md#view-surfaces). A subscription call of the view
// registers one listener in the page, and each event that the listener receives is pushed to the view as a host message
// {sok: 1, event, data} through push. The subscriptions end when the surface closes or its document process ends.

/** The key of a status watch: a watch of a name on a surface is apart from a watch of the name on another surface or on the workbench. */
// default: a watch without a surface is the watch of the name on the workbench, keyed by null.
const statusKey = (name, surface) => `status:${JSON.stringify([name, surface ?? null])}`;

/** The data of the status event of a watch: the surface is a member only when the watch names one. */
const statusData = (name, surface, value) => (surface === undefined ? { name, value } : { name, surface, value });

/**
 * Creates the subscriptions of one view surface.
 *
 *     native      native(name, fn): the surface event of the name, as runtime.native.on; resolves with the off function
 *     sidecar     the sidecar of the surface with on(id, fn) and onFailure(id, fn), as runtime.sidecar() has; each resolves with the off function
 *     textSize    textSize(fn): registers fn(factor) for the changes of the text scale of the surface, as runtime.textSize.on does;
 *                 resolves with the off function
 *     settings    settings(fn): registers fn(values) for the changes of the settings of the plugin, as runtime.settings.on does;
 *                 resolves with the off function
 *     data        data(fn): registers fn(key) for the changes of the project data of the plugin for the start project of the view;
 *                 resolves with the off function
 *     logLevels   {read(), on(fn)}: read() returns the stored levels of a record of the plugin, and on(fn) registers fn for each
 *                 change of the policy in force; on resolves with the off function
 *     status      status(name, surface, fn): follows the value of the status name on the surface, as the registry observe does, and on the
 *                 workbench when surface is undefined; fn(value) receives each value and the function returns the unsubscribe function,
 *                 which it calls at the end of the watch
 *     push        push(event, data): posts {event, data} to the view through viewEvent; rejects when the host refuses it
 *     closing     optional AbortSignal of the surface lifetime; a refusal after abort cancels delivery
 *     leftOut     leftOut(): whether a drawing or a place left the surface out; an event that is delivered while it is cancels, because
 *                 the host has closed or will close the view, and a section that is drawn again in the same drawing receives the next event
 *     cancel      cancel(event): records a delivery canceled by document or surface end
 *     report      report(text): receives the text of a push that the host refused
 *
 * Returns {native(name), sidecarMessage(id), sidecarFailure(id), textSize(), settings(), data(), logLevels(), statusWatch(name, surface),
 * statusUnwatch(name, surface), restart(), close()}. A subscription call resolves with null, and a second call for the same name or id registers
 * nothing; a status watch is keyed by its name and its surface.
 * restart() ends current subscriptions and invalidates pending deliveries while allowing the new document to subscribe again. An unwatch
 * of a name that is not watched ends nothing and resolves with null. A refusal after document or surface end is canceled; a refusal while
 * the current document remains open is reported.
 */
export function createViewSubscriptions({ native, sidecar, textSize, settings, data, logLevels, status, push, report, closing, leftOut = () => false, cancel = () => {} }) {
  if (typeof push !== "function" || typeof report !== "function") {
    throw new TypeError("createViewSubscriptions requires the push and report functions");
  }
  // The registration of each key and its off function, by key. A key is native:<name>, sidecar.message:<id>, sidecar.failure:<id>,
  // or a status key (statusKey).
  const registered = new Map();
  // A restarted host process is a new document even though its surface stays mounted.
  let generation = 0;
  // Set by close: an event that arrives after the surface closed is canceled without a host send.
  let closed = false;
  let delivery = Promise.resolve();
  const forward = (event, data, owner = generation) => {
    delivery = delivery.then(async () => {
      // A view whose surface a drawing or a place left out receives nothing until it is drawn again (docs/spec/plugins.md#sections).
      if (closed || closing?.aborted || owner !== generation || leftOut()) {
        cancel(event);
        return;
      }
      try {
        await push(event, data);
      } catch (error) {
        if (closed || closing?.aborted || owner !== generation) {
          cancel(event);
          return;
        }
        // default: a refusal that is not an Error carries its value as the text.
        report(`view event ${event}: ${error?.message ?? error}`);
      }
    });
  };
  // A registrar returns a promise of the off function, the one form that every registrar gives (docs/spec/native-surfaces.md#view-surfaces).
  // Any other result, and a synchronous throw, refuse the key with an error that names the registrar.
  const registration = (key, register) => {
    let result;
    try {
      result = register();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!(result instanceof Promise)) {
      return Promise.reject(new TypeError(`view subscription ${key}: the registrar returned ${typeof result}, want a promise of the off function`));
    }
    return result;
  };
  const subscribe = (key, register) => {
    if (closed) return Promise.reject(new Error("view subscriptions are closed"));
    if (registered.has(key)) return Promise.resolve(null);
    const owner = generation;
    const pending = registration(key, register).then((off) => {
      if (owner !== generation || closed) {
        return Promise.resolve(off()).then(() => null);
      }
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
        const owner = generation;
        return native(name, (data) => forward(name, data, owner));
      });
    },
    sidecarMessage(id) {
      return subscribe(`sidecar.message:${id}`, () => {
        const owner = generation;
        return sidecar.on(id, (body) => forward("sidecar.message", { id, body }, owner));
      });
    },
    sidecarFailure(id) {
      return subscribe(`sidecar.failure:${id}`, () => {
        const owner = generation;
        return sidecar.onFailure(id, (reason) => forward("sidecar.failure", { id, reason }, owner));
      });
    },
    textSize() {
      return subscribe("textSize", () => {
        const owner = generation;
        return textSize((factor) => forward("textSize", factor, owner));
      });
    },
    settings() {
      return subscribe("settings", () => {
        const owner = generation;
        return settings((values) => forward("settings", values, owner));
      });
    },
    // A change of a key of the project data is pushed as the event data with {key}; the view reads the value with runtime.data.get.
    data() {
      return subscribe("data", () => {
        const owner = generation;
        return data((key) => forward("data", { key }, owner));
      });
    },
    // The stored levels are read again at each change of the policy, and only levels that differ from the last are pushed.
    logLevels() {
      return subscribe("log.levels", () => {
        const owner = generation;
        let last = logLevels.read().join();
        return logLevels.on(() => {
          const next = logLevels.read();
          if (next.join() === last) return;
          last = next.join();
          forward("log.levels", next, owner);
        });
      });
    },
    // A status is watched once per name and surface: the value of the status is pushed as the event status with {name, value}, and with
    // surface as well when the watch names one.
    statusWatch(name, surface) {
      // A refusal of the page is a rejection, so the executor carries a synchronous throw of the observation into it.
      return subscribe(statusKey(name, surface), () => new Promise((resolve) => {
        const owner = generation;
        resolve(status(name, surface, (value) => forward("status", statusData(name, surface, value), owner)));
      }));
    },
    statusUnwatch(name, surface) {
      const key = statusKey(name, surface);
      const off = registered.get(key);
      if (off === undefined) return Promise.resolve(null);
      registered.delete(key);
      return Promise.resolve(off()).then(() => null);
    },
    async restart() {
      if (closed) throw new Error("view subscriptions are closed");
      generation += 1;
      const offs = [...registered.values()];
      registered.clear();
      for (const off of offs) await off();
    },
    async close() {
      closed = true;
      const offs = [...registered.values()];
      registered.clear();
      for (const off of offs) await off();
    },
  };
}
