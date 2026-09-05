// Gives the page real native surfaces, and a native view for its modals.
//
// Surfaces: the page declares, on every commit, the frame each one should
// occupy, and each becomes a child webview on that frame. A browser pane shows
// a live page; a terminal pane shows a local page with a shell process behind
// it. Both are native views, which is what the example is about.
//
// Modals: DOM cannot be drawn over a native view, so a [data-native-modal]
// element is handed to a webview of its own, created after the surfaces and
// therefore above them.
const { invoke } = window.__TAURI__?.core ?? {};
const { listen } = window.__TAURI__?.event ?? {};
// What each kind of surface shows. A browser pane is a live page; a terminal
// pane is a local page with a shell process behind it.
const SURFACE_URL = {
  browser: () => "https://www.google.com",
  terminal: (id) => `terminal.html?id=${encodeURIComponent(id)}`,
};

/** The colour a surface shows where its page has not painted yet. */
function surfaceBackground() {
  const css = getComputedStyle(document.documentElement).getPropertyValue("--surface");
  const probe = document.createElement("span");
  probe.style.color = css.trim() || "#000";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? [0, 0, 0];
  probe.remove();
  return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
}

/** Page coordinates for a rect the page gave in plane coordinates. */
function toPage(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: plane.left + rect.x, y: plane.top + rect.y, w: rect.w, h: rect.h };
}

/** The four channels of a computed CSS colour; alpha defaults to opaque. */
function rgba(css) {
  const n = (css.match(/[\d.]+/g) ?? []).map(Number);
  return [n[0] || 0, n[1] || 0, n[2] || 0, n[3] === undefined ? 1 : n[3]];
}

/** The three channels of a computed CSS colour. */
const rgb = (css) => rgba(css).slice(0, 3);

/**
 * A colour laid over another, as an opaque colour.
 *
 * The page's own colours are partly transparent, and in the page they land on
 * the plane behind them. A modal drawn natively lands on whatever the surface
 * below is showing instead, so a translucent border washes out over a white
 * page. Compositing it here keeps the modal looking the way the page does.
 */
function over(colour, ground) {
  const [r, g, b, a] = rgba(colour);
  const [br, bg, bb] = rgba(ground);
  const mix = (c, d) => Math.round(c * a + d * (1 - a));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
}

/** The viewport size lets the app work out how far the page sits inside the
 *  window's content view; on macOS that is the height of the title bar. */
const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

if (!invoke) {
  console.warn("no Tauri bridge; the page stays fully simulated");
} else {
  let lastSync = "";

  window.hostSurfaces = {
    kinds: ["browser", "terminal"],

    place(record) {
      const surfaces = record.surfaces
        .filter((s) => SURFACE_URL[s.plugin])
        .map((s) => ({
          id: s.id,
          kind: s.plugin,
          url: SURFACE_URL[s.plugin](s.id),
          visible: s.visible,
          // A webview leaves unpainted area white, and a divider drag resizes a
          // surface every frame, so the strip it just uncovered flashes white
          // until the page paints it. Starting the view on the colour the page
          // uses for a surface means there is no white to see.
          background: surfaceBackground(),
          ...toPage(s.applied),
        }));

      // A commit arrives on every render, including every frame of a divider
      // drag. Sending an unchanged request would cross the bridge for nothing.
      const request = { viewport: viewport(), surfaces };
      const key = JSON.stringify(request);
      if (key === lastSync) return;
      lastSync = key;
      invoke("sync_surfaces", { request }).catch((e) => console.error("sync_surfaces", e));
    },
  };

  // A modal's view is built when the modal opens, and a webview is white until
  // its document is fetched and painted. Asking for that document now puts it in
  // the cache, so the fetch the first modal makes has nothing to wait for.
  fetch("overlay.html").catch(() => {});

  let pick = null;
  let shown = null;
  listen("overlay-pick", (e) => {
    const done = pick;
    pick = null;
    if (done) done(e.payload);
  });

  window.hostOverlay = {
    show(el, rect, onPick) {
      pick = onPick;
      shown = el.id || "modal";
      const style = getComputedStyle(el);
      invoke("overlay_show", {
        request: {
          id: el.id || "modal",
          viewport: viewport(),
          rect: toPage(rect),
          className: el.className,
          html: el.innerHTML,
          css: [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n"),
          background: rgb(style.backgroundColor),
          border: over(style.borderTopColor, style.backgroundColor),
          background: rgb(style.backgroundColor),
          radius: parseFloat(style.borderTopLeftRadius) || 0,
        },
      }).catch((e) => console.error("overlay_show", e));
    },

    hide() {
      const id = shown;
      shown = null;
      pick = null;
      if (id) invoke("overlay_hide", { id }).catch((e) => console.error("overlay_hide", e));
    },
  };
}
