// The application update state and operation of the window (docs/spec/installation.md#application-update).

/**
 * The page of a published release for the URL of its file, `<repository>/releases/download/<tag>/<file>`; null for any
 * other URL, which names no page.
 */
export function releasePage(url) {
  const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/releases\/download\/([^/]+)\/[^/]+$/.exec(url);
  return match ? `${match[1]}/releases/tag/${match[2]}` : null;
}

/**
 * The application update of this window. `host` is null without the application host. `changed` is called whenever the
 * state or the operation changes.
 */
export function createAppUpdate({ host, changed }) {
  let state = null;
  let failure = null;
  let operation = null;

  /** Reads the candidate of the registry index again. A read that fails is the error of the status. */
  async function refresh() {
    if (!host) return;
    try {
      state = await host.call("appUpdateState");
      failure = null;
    } catch (error) {
      state = null;
      failure = error.message;
    } finally {
      changed();
    }
  }

  /** Stages the candidate, then applies the staged bundle, which quits the application. */
  async function update() {
    if (!host) throw new Error("the application update needs a native host");
    if (!state?.available) throw new Error("no application update is available");
    const { version } = state.available;
    operation = { state: "staging", version, error: null };
    changed();
    try {
      const { bundle } = await host.call("appUpdateStage", { version });
      operation = { state: "applying", version, error: null };
      changed();
      await host.call("appUpdateApply", { bundle });
    } catch (error) {
      operation = { state: "failed", version, error: error.message };
      changed();
      throw error;
    }
  }

  /** Opens the release page of the candidate in the default application of the person. */
  async function openRelease() {
    if (!host) throw new Error("the application update needs a native host");
    const url = status().available?.release;
    if (!url) throw new Error("the application update has no release page");
    await host.call("linkOpen", { url });
  }

  /** The value of the core.app status. */
  function status() {
    return {
      // default: before the first read, and after a read that failed, the version is null (core.app).
      version: state?.version ?? null,
      available: state?.available ? { version: state.available.version, release: releasePage(state.available.release.url) } : null,
      operation,
      error: failure,
    };
  }

  return { refresh, update, openRelease, status };
}
