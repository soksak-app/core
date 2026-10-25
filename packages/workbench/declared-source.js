// The declared UI snapshot transport of the main page (docs/spec/declared-ui.md, status mapping;
// docs/spec/plugin-host.md#declared-ui-snapshots). One window listener acknowledges every snapshot once,
// then routes it to the current recipient of its source and status.
import { host as bridge } from "@soksak/runtime";
import { createSnapshotReceiver, SNAPSHOT_EVENT, SNAPSHOT_REQUEST_COMMAND } from "@soksak/plugin-api";
import { viewCommandGenerationOf, viewCommandsOf } from "./view-commands.js";
import { hostCommandGeneration, hostCommandsOf, pluginOfHostKey } from "./plugin-host.js";
import { endSourceOrigin, registerSourceOrigin, seedSourceOrigins, sourceOrigin } from "./source-origins.js";
import { registry } from "./exposure.js";
import { acceptSnapshotSequence, replaceSnapshotSource, retireSnapshotSource } from "./plugin-processes.js";

const recipients = new Map();
const recipientKey = (plugin, surface, status, generation) => JSON.stringify([plugin, surface, status, generation]);
let bufferedOrigins = [];
let originSnapshotReady = false;

function report(error) {
  dispatchEvent(new ErrorEvent("error", { message: `declared UI snapshot ingress: ${error?.message ?? error}` })); // default: thrown non-Error values are included as their text.
}

function acknowledge(event, generation, message) {
  const request = event.surface === undefined
    ? bridge.call("pluginHostEvent", { plugin: message.plugin, generation, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } })
    : bridge.call("viewEvent", { surface: event.surface, generation, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } });
  return Promise.resolve(request).then((accepted) => accepted === true, (error) => {
    report(error);
    return false;
  });
}

function activeGeneration(plugin, surface) {
  return sourceOrigin(plugin, surface ?? null); // default: an absent surface identifies the plugin-host source.
}

function acceptGeneration(event) {
  if (!Number.isSafeInteger(event?.generation) || event.generation < 1) {
    throw new TypeError("declared UI snapshot has no positive source generation");
  }
  const surface = event.surface ?? null; // default: a source lifecycle event without a surface belongs to the plugin host.
  const previous = activeGeneration(event.plugin, surface);
  const accepted = registerSourceOrigin(event.plugin, surface, event.generation);
  if (accepted && previous !== event.generation) replaceSnapshotSource(event.plugin, surface, event.generation);
  return accepted;
}

function receive(event) {
  if (!event || typeof event !== "object" || typeof event.plugin !== "string" || event.plugin === "") {
    throw new TypeError("declared UI snapshot ingress requires a plugin id");
  }
  const surface = event.surface;
  if (surface !== undefined && (typeof surface !== "string" || surface === "")) {
    throw new TypeError(`declared UI snapshot of ${event.plugin} has an invalid surface`);
  }
  if (!acceptGeneration(event)) return;
  const generation = event.generation;
  const listeners = recipients.get(recipientKey(event.plugin, surface ?? null, event.status, generation)); // default: absent surface identifies the plugin-host source.
  const targets = [...(listeners ?? [])]; // default: a status without subscribers has no recipients.
  let ack;
  // The SDK receiver is ephemeral: its synchronous transport delivers this one wire event and retains no listener after return.
  const receiver = createSnapshotReceiver({
    plugin: event.plugin,
    send: (message) => { ack = acknowledge(event, generation, message); },
    onMessage: (listener) => {
      listener({ event: SNAPSHOT_EVENT, plugin: event.plugin, status: event.status,
        seq: event.seq, value: event.value, skipped: event.skipped });
      return () => {};
    },
    onSnapshot: (status, seq, value, skipped) => {
      const delivery = Promise.resolve(ack).then((accepted) => {
        if (!accepted || activeGeneration(event.plugin, surface) !== generation) return;
        if (registry.declared("status", `${event.plugin}.${status}`)) {
          acceptSnapshotSequence(event.plugin, status, surface ?? null, generation, seq); // default: absent surface identifies the plugin-host source.
        }
        for (const recipient of targets) {
          if (listeners?.has(recipient) && activeGeneration(event.plugin, surface) === generation) {
            try {
              recipient({ event: SNAPSHOT_EVENT, plugin: event.plugin, status, seq, value, skipped });
            } catch (error) {
              report(error);
            }
          }
        }
      });
      delivery.catch(report);
    },
  });
  if (typeof receiver !== "function") throw new TypeError("declared UI snapshot ingress did not complete its ephemeral receiver");
}

function receiveOriginLifecycle(event, ended) {
  if (!event || typeof event !== "object" || typeof event.plugin !== "string" || event.plugin === "") {
    throw new TypeError("declared UI source lifecycle event requires a plugin id");
  }
  const surface = event.surface ?? null; // default: a source lifecycle event without a surface belongs to the plugin host.
  if (event.surface !== undefined && (typeof surface !== "string" || surface === "")) {
    throw new TypeError(`declared UI source lifecycle event of ${event.plugin} has an invalid surface`);
  }
  if (!Number.isSafeInteger(event.generation) || event.generation < 1) {
    throw new TypeError("declared UI source lifecycle event requires a positive source generation");
  }
  if (ended) {
    if (endSourceOrigin(event.plugin, surface, event.generation)) {
      retireSnapshotSource(event.plugin, surface, event.generation);
    }
  } else {
    const previous = activeGeneration(event.plugin, surface);
    if (registerSourceOrigin(event.plugin, surface, event.generation) && previous !== event.generation) {
      replaceSnapshotSource(event.plugin, surface, event.generation);
    }
  }
}

function consumeBuffered(event) {
  try {
    if (event.name === "declared-ui-snapshot") receive(event.value);
    else receiveOriginLifecycle(event.value, event.name === "declared-ui-source-ended");
  } catch (error) {
    report(error);
  }
}

let listenerReady = null;
let ingressReady = null;

/** Installs the window snapshot listener before provider lifecycle listeners and does not start a provider. */
export function prepareDeclaredSnapshotIngress() {
  if (listenerReady !== null) return listenerReady;
  if (!bridge) {
    listenerReady = Promise.resolve(() => {});
    return listenerReady;
  }
  try {
    const names = ["declared-ui-snapshot", "declared-ui-source-registered", "declared-ui-source-ended"];
    listenerReady = Promise.allSettled(names.map((name) => Promise.resolve(bridge.on(name, (event) => {
      if (originSnapshotReady) consumeBuffered({ name, value: event });
      else bufferedOrigins.push({ name, value: event });
    })))).then((results) => {
      const installed = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) {
        installed.forEach((unsubscribe) => { if (typeof unsubscribe === "function") unsubscribe(); });
        throw failure.reason;
      }
      if (installed.some((unsubscribe) => typeof unsubscribe !== "function")) {
        installed.forEach((unsubscribe) => { if (typeof unsubscribe === "function") unsubscribe(); });
        throw new TypeError("declared UI source ingress listener did not return an unsubscribe function");
      }
      return () => installed.forEach((unsubscribe) => unsubscribe());
    });
  } catch (error) {
    listenerReady = Promise.reject(error);
  }
  listenerReady.catch((error) => error);
  return listenerReady;
}

/** Starts the single snapshot listener, seeds native source generations, and drains events received during the query. */
export function startDeclaredSnapshotIngress() {
  if (ingressReady !== null) return ingressReady;
  if (!bridge) {
    originSnapshotReady = true;
    ingressReady = prepareDeclaredSnapshotIngress();
    return ingressReady;
  }
  ingressReady = prepareDeclaredSnapshotIngress().then((unsubscribe) => {
    return bridge.call("declaredSourceOrigins").then((snapshot) => {
        if (!snapshot || !Number.isSafeInteger(snapshot.floor) || snapshot.floor < 0 || !snapshot.pluginHosts || !snapshot.views) {
          throw new TypeError("declared UI source origin snapshot is invalid");
        }
        seedSourceOrigins(snapshot);
        originSnapshotReady = true;
        const queued = bufferedOrigins;
        bufferedOrigins = [];
        for (const event of queued) consumeBuffered(event);
        return unsubscribe;
      }).catch((error) => {
        unsubscribe();
        throw error;
      });
  });
  // Startup awaits this promise after its synchronous first draw and asynchronous storage setup. Observe a rejection immediately
  // to prevent an early unhandled-rejection event; this handler returns the cause as a fulfilled observation value, while callers
  // still receive the original rejected promise at their startup boundary.
  ingressReady.catch((error) => error);
  return ingressReady;
}

/** Runs provider startup only after the window can receive and acknowledge snapshots. */
export function afterDeclaredSnapshotIngress(start) {
  if (typeof start !== "function") throw new TypeError("declared UI snapshot ingress requires a startup operation");
  return startDeclaredSnapshotIngress().then(start);
}

/**
 * Creates the source adapter of one plugin status. Its channel registers and removes a recipient from the window ingress;
 * pull requests the current value through the view or plugin-host command layer.
 */
export function createDeclaredSource({ plugin, status }) {
  if (typeof plugin !== "string" || plugin === "") throw new TypeError("the declared source requires the plugin id");
  if (typeof status !== "string" || status === "") throw new TypeError(`the declared source of ${plugin} requires a status name`);
  const where = `${plugin}.${status}`;
  return {
    channel(source) {
      if (!source || (source.surface !== null && (typeof source.surface !== "string" || source.surface === ""))) {
        throw new TypeError(`${where}: snapshot channel requires a view surface or plugin host source`);
      }
      const surface = source.surface;
      if (!Number.isSafeInteger(source.generation) || source.generation < 1) {
        throw new TypeError(`${where}: snapshot channel requires a positive source generation`);
      }
      const key = recipientKey(plugin, surface, status, source.generation);
      return {
        onMessage: (receive) => startDeclaredSnapshotIngress().then(() => {
          let listeners = recipients.get(key);
          if (!listeners) recipients.set(key, listeners = new Set());
          let closed = false;
          const recipient = (message) => {
            if (closed) return;
            receive(message);
          };
          listeners.add(recipient);
          return () => {
            closed = true;
            listeners.delete(recipient);
            if (listeners.size === 0 && recipients.get(key) === listeners) recipients.delete(key);
          };
        }),
      };
    },
    expanded(source, request) {
      const data = { status, tree: request.tree, path: request.path, expanded: request.expanded };
      if (source.surface === null) return bridge.call("pluginHostEvent", { plugin, generation: source.generation, event: "declared-ui.expanded", data });
      return bridge.call("viewEvent", { surface: source.surface, generation: source.generation, event: "declared-ui.expanded", data });
    },
    pull(source) {
      if (source.surface === null) {
        const host = hostCommandsOf(pluginOfHostKey(source.id));
        if (host === null) return Promise.reject(new Error(`${where}: the plugin host has no channel`));
        if (hostCommandGeneration(pluginOfHostKey(source.id)) !== source.generation || activeGeneration(plugin, null) !== source.generation) {
          return Promise.resolve({ cancelled: true, sourceGeneration: source.generation });
        }
        return host.run(SNAPSHOT_REQUEST_COMMAND, { status });
      }
      const layer = viewCommandsOf(source.surface);
      if (layer === null) return Promise.reject(new Error(`${where}: surface ${source.surface} has no view command layer`));
      if (viewCommandGenerationOf(source.surface) !== source.generation || activeGeneration(plugin, source.surface) !== source.generation) {
        return Promise.resolve({ cancelled: true, sourceGeneration: source.generation });
      }
      return layer.run(SNAPSHOT_REQUEST_COMMAND, { status });
    },
  };
}
