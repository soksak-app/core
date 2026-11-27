// The setup parts of the agents of this machine: the agent group of the settings tab, the core.setup status and the
// core.setup commands (docs/spec/settings.md#agents). The host reads and installs the parts with the
// setup library of its command line in the environment of the login shell of the person (docs/spec/cli.md#agents-in-the-application).
// The parts are read when the group is shown, and while it is shown when the window becomes the key window and after setup-changed,
// and by core.setup.check; no timer reads them, because the configuration file of the agent is rewritten by every agent session.
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";
import { errorText } from "./error-text.js";

/** The kinds of parts that the application installs on request. */
export const SETUP_KINDS = ["skill", "mcp"];

/** The error of a setup operation of a window without a host. */
export const NO_HOST = "setup operations need a native host";

/** The kinds among SETUP_KINDS that have a part that is not ok, in the order of SETUP_KINDS. */
export function missingKinds(parts) {
  return SETUP_KINDS.filter((kind) => parts.some((part) => part.part === kind && part.state !== "ok"));
}

/** Returns parts when it is a non-empty list of SETUP_KINDS without repetition, and throws the invalid-params error otherwise. */
export function setupKinds(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.some((kind) => !SETUP_KINDS.includes(kind)) || new Set(parts).size !== parts.length) {
    throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `parts must be a non-empty list of skill and mcp without repetition: ${JSON.stringify(parts)}`);
  }
  return parts;
}

/**
 * The setup parts of one window. host is the host transport of the page or null without a host; changed is called when the
 * parts or the running install change, and failed(text) shows a failed read or install through the error display, which writes
 * it to the application log. A failure keeps the parts of the last read.
 */
export function createSetupParts({ host, changed, failed }) {
  let parts = [];
  let running = null;
  let shown = false;
  // The number of the last started read: a read that ends after a later read or install started does not replace its parts.
  let lastRead = 0;

  /** Reads the parts through setupState and answers `{value}`, or shows the failure and answers `{error}`. */
  async function load() {
    const order = ++lastRead;
    try {
      const value = await host.call("setupState");
      if (order === lastRead) {
        parts = value.parts;
        changed();
      }
      return { value };
    } catch (error) {
      failed(`setup: ${errorText(error)}`);
      return { error };
    }
  }

  /** Reads the parts through setupState; a failure is shown and rejects. */
  async function read() {
    if (!host) throw new Error(NO_HOST);
    const { value, error } = await load();
    if (error) throw error;
    return value;
  }

  /** Applies a setup operation and keeps the parts it answers. */
  async function apply(method, params, kinds) {
    if (!host) throw new Error(NO_HOST);
    // The host runs one setup operation at a time, so running names the parts of the current operation.
    if (running) {
      const error = new Error("another setup operation is running");
      failed(`setup: ${error.message}`);
      throw error;
    }
    running = kinds;
    changed();
    const order = ++lastRead;
    try {
      const value = await host.call(method, params);
      if (order === lastRead) parts = value.parts;
      return value;
    } catch (error) {
      failed(`setup: ${errorText(error)}`);
      throw error;
    } finally {
      running = null;
      changed();
    }
  }

  async function install(kinds) {
    setupKinds(kinds);
    return apply("setupInstall", { parts: kinds }, kinds);
  }

  function change({ part, enabled }) {
    return apply("setupChange", { part, enabled }, [part]);
  }

  /** A read that an event of the host or the showing of the group starts; load shows its failure and does not reject. */
  function reread() {
    load();
  }

  /**
   * Records whether the agent group is shown. Showing it reads the parts; while it is shown, window-active and setup-changed read
   * them again.
   */
  function show(now) {
    const appears = now && !shown;
    shown = now;
    if (appears && host) reread();
  }

  /** Subscribes to the events of the host that read the parts again while the group is shown. */
  function follow() {
    if (!host) return;
    for (const event of ["window-active", "setup-changed"]) host.on(event, () => { if (shown) reread(); });
  }

  return {
    read, install, change, show, follow,
    parts: () => parts,
    status: () => ({ parts, running }),
  };
}
