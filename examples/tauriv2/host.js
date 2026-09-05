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

/** The viewport size, which the app uses to place a view inside its window. */
const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

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

if (!invoke) {
  console.warn("no Tauri bridge; the page stays fully simulated");
} else {
  let lastSync = "";

  // The page applies its theme before this host is in place, so the first
  // commit is where the theme it is drawn in is asked for: a commit is the page
  // saying it is up.
  let announced = false;

  window.hostSurfaces = {
    kinds: ["browser", "terminal"],

    theme(values) {
      invoke("set_theme", { theme: values });
    },

    place(record) {
      if (!announced) {
        announced = true;
        this.theme(window.pageTheme());
      }
      const surfaces = record.surfaces
        .filter((s) => SURFACE_URL[s.plugin])
        .map((s) => ({
          id: s.id,
          kind: s.plugin,
          layer: s.layer,
          dim: s.dim,
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

  // A surface is a native view, so a press on it never reaches this document.
  // The app names the surface and the page presses it, which is what everything
  // listening for a press already understands.
  listen("surface-pressed", (e) => window.pressSurface(e.payload));

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
      // The view is named after the element, so an element without an id has
      // no name. Two of them would share one view.
      if (!el.id) throw new Error("a [data-native-modal] element needs an id");
      shown = el.id;
      const style = getComputedStyle(el);
      invoke("overlay_show", {
        request: {
          id: el.id,
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
