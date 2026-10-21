// The injected document-start script of a view page (docs/spec/plugin-processes.md, rule 4). The application injects this file's
// text into each view configuration before any page script runs. It has no import, so it runs as a plain script.
//
// The script posts the ready message with the document identifier of the page through the sok-view handler. It adds the
// window message listener, and it keeps each host message (a message event whose source is the window and that carries
// sok: 1) until a listener attaches. The one global is window.sokView, whose attach is the only way to read host messages.
// A message that fails a check is reported through the handler as an error and passed to no listener. A message past the
// queue limit is reported and dropped; the host ends the view process on that report.
(() => {
  const QUEUE_LIMIT = 256;
  const MARKER = 1;
  const plugin = window.location.host;
  const handler = window.webkit.messageHandlers["sok-view"];
  // Host messages waiting for the listener, in arrival order.
  const queue = [];
  let listener = null;

  const refuse = (reason) => {
    handler.postMessage({ event: "view.error", plugin, reason: `${reason} for ${plugin}` });
  };

  const deliver = (message) => {
    if (listener) {
      listener(message);
      return;
    }
    if (queue.length >= QUEUE_LIMIT) {
      refuse("queue full");
      return;
    }
    queue.push(message);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      refuse("message from another source");
      return;
    }
    const data = event.data;
    if (typeof data !== "object" || data === null || data.sok !== MARKER) {
      refuse("message without the sok marker");
      return;
    }
    deliver(data);
  });

  handler.postMessage({ event: "view.ready", plugin, document: crypto.randomUUID() });

  window.sokView = Object.freeze({
    attach(next) {
      if (typeof next !== "function") throw new TypeError("attach requires a listener function");
      if (listener) throw new Error(`view channel for ${plugin} already has a message listener`);
      listener = next;
      while (queue.length > 0 && listener === next) next(queue.shift());
    },
  });
})();
