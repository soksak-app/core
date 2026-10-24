// The declared UI snapshot transport of the main page (docs/spec/declared-ui.md, status mapping;
// docs/spec/plugin-host.md#declared-ui-snapshots). One window listener acknowledges every snapshot once,
// then routes it to the current recipient of its source and status.
import { host as bridge } from "@soksak/runtime";
import { createSnapshotReceiver, SNAPSHOT_EVENT, SNAPSHOT_REQUEST_COMMAND } from "@soksak/plugin-api";
import { viewCommandsOf } from "./view-commands.js";
import { hostCommandsOf, pluginOfHostKey } from "./plugin-host.js";

const recipients = new Map();
const recipientKey = (plugin, surface, status) => JSON.stringify([plugin, surface, status]);

function report(error) {
  dispatchEvent(new ErrorEvent("error", { message: `declared UI snapshot ingress: ${error?.message ?? error}` }));
}

function acknowledge(event, message) {
  const request = event.surface === undefined
    ? bridge.call("pluginHostEvent", { plugin: message.plugin, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } })
    : bridge.call("viewEvent", { surface: event.surface, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } });
  Promise.resolve(request).catch(report);
}

function receive(event) {
  if (!event || typeof event !== "object" || typeof event.plugin !== "string" || event.plugin === "") {
    throw new TypeError("declared UI snapshot ingress requires a plugin id");
  }
  const surface = event.surface;
  if (surface !== undefined && (typeof surface !== "string" || surface === "")) {
    throw new TypeError(`declared UI snapshot of ${event.plugin} has an invalid surface`);
  }
  // The SDK receiver is ephemeral: its synchronous transport delivers this one wire event and retains no listener after return.
  const receiver = createSnapshotReceiver({
    plugin: event.plugin,
    send: (message) => acknowledge(event, message),
    onMessage: (listener) => {
      listener({ event: SNAPSHOT_EVENT, plugin: event.plugin, status: event.status,
        seq: event.seq, value: event.value, skipped: event.skipped });
      return () => {};
    },
    onSnapshot: (status, seq, value, skipped) => {
      const key = recipientKey(event.plugin, surface ?? null, status);
      for (const recipient of [...(recipients.get(key) ?? [])]) {
        recipient({ event: SNAPSHOT_EVENT, plugin: event.plugin, status, seq, value, skipped });
      }
    },
  });
  if (typeof receiver !== "function") throw new TypeError("declared UI snapshot ingress did not complete its ephemeral receiver");
}

let ingressReady = null;

/** Starts the single native snapshot listener and resolves after its registration, or immediately without a native host. */
export function startDeclaredSnapshotIngress() {
  if (ingressReady !== null) return ingressReady;
  if (!bridge) {
    ingressReady = Promise.resolve(() => {});
    return ingressReady;
  }
  try {
    ingressReady = Promise.resolve(bridge.on("declared-ui-snapshot", (event) => {
      try {
        receive(event);
      } catch (error) {
        report(error);
      }
    })).then((unsubscribe) => {
      if (typeof unsubscribe !== "function") throw new TypeError("declared UI snapshot ingress listener did not return an unsubscribe function");
      return unsubscribe;
    });
  } catch (error) {
    ingressReady = Promise.reject(error);
  }
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
      const key = recipientKey(plugin, surface, status);
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
      if (source.surface === null) return bridge.call("pluginHostEvent", { plugin, event: "declared-ui.expanded", data });
      return bridge.call("viewEvent", { surface: source.surface, event: "declared-ui.expanded", data });
    },
    pull(source) {
      if (source.surface === null) {
        const host = hostCommandsOf(pluginOfHostKey(source.id));
        if (host === null) return Promise.reject(new Error(`${where}: the plugin host has no channel`));
        return host.run(SNAPSHOT_REQUEST_COMMAND, { status });
      }
      const layer = viewCommandsOf(source.surface);
      if (layer === null) return Promise.reject(new Error(`${where}: surface ${source.surface} has no view command layer`));
      return layer.run(SNAPSHOT_REQUEST_COMMAND, { status });
    },
  };
}
