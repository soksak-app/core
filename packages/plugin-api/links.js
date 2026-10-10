// The link opening capability. The host checks the scheme and opens the link with the default application of the user
// (docs/spec/plugins.md#opening-links).

export function createLinkBridge(call) {
  if (typeof call !== "function") throw new TypeError("link bridge requires a call function");
  return Object.freeze({
    open(url) {
      if (typeof url !== "string" || url.length === 0) {
        return Promise.reject(new TypeError("link URL must be a non-empty string"));
      }
      return Promise.resolve(call("linkOpen", { url })).then(() => undefined);
    },
  });
}
