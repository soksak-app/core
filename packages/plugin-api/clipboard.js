// Typed clipboard capability shared by surface modules and application runtimes.

export const CLIPBOARD_TYPES = Object.freeze(["text", "png", "fileURLs"]);

export class ClipboardError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ClipboardError";
  }
}

function typeOf(type) {
  if (!CLIPBOARD_TYPES.includes(type)) {
    throw new TypeError(`clipboard type must be one of ${CLIPBOARD_TYPES.join(", ")}`);
  }
  return type;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("clipboard PNG data must be Uint8Array or ArrayBuffer");
}

function base64Of(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function bytesFrom(value) {
  if (typeof value !== "string") throw new ClipboardError("clipboard PNG response is not base64");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Return a shell argument, never a command. */
export function shellQuotePath(path) {
  if (typeof path !== "string" || path.length === 0) throw new ClipboardError("clipboard file path is invalid");
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function readValue(type, response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new ClipboardError(`clipboard ${type} response is missing or malformed`);
  }
  if (response.present === false) {
    if (response.type !== type) throw new ClipboardError(`clipboard absent response type mismatch for ${type}`);
    return null;
  }
  if (response.present !== true || response.type !== type) {
    throw new ClipboardError(`clipboard response type mismatch for ${type}`);
  }
  if (type === "text") {
    if (typeof response.text !== "string") throw new ClipboardError("clipboard text response is invalid");
    return response.text;
  }
  if (type === "png") return bytesFrom(response.data);
  if (!Array.isArray(response.urls) || response.urls.some((url) => typeof url !== "string")) {
    throw new ClipboardError("clipboard file URL response is invalid");
  }
  return [...response.urls];
}

/**
 * Build the scoped plugin capability over an application transport.
 * `persistPNG` is deliberately omitted unless the caller opts into the plugin-only capability.
 */
export function createClipboardBridge(call, { allowPersist = false } = {}) {
  if (typeof call !== "function") throw new TypeError("clipboard bridge requires a call function");
  const bridge = {
    read(type) {
      try { typeOf(type); } catch (error) { return Promise.reject(error); }
      return Promise.resolve(call("clipboardRead", { type, userInitiated: true })).then((response) => readValue(type, response));
    },
    writeText(text) {
      if (typeof text !== "string") throw new TypeError("clipboard text must be a string");
      return Promise.resolve(call("clipboardWriteText", text)).then(() => undefined);
    },
  };
  if (allowPersist) {
    bridge.persistPNG = (value) => {
      let data;
      try { data = base64Of(bytesOf(value)); } catch (error) { return Promise.reject(error); }
      return Promise.resolve(call("clipboardPersistPNG", { data }))
      .then((response) => {
        if (!response || typeof response.path !== "string" || response.path.length === 0) {
          throw new ClipboardError("clipboard PNG persistence response is invalid");
        }
        return { path: response.path, shellQuotedPath: shellQuotePath(response.path) };
      });
    };
  }
  return Object.freeze(bridge);
}
