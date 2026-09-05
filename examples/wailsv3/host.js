// Gives the page real native surfaces.
//
// The page declares, on every commit, the frame each surface should occupy, and
// each becomes a real webview: a browser pane shows a live page, a terminal pane
// shows a local page with a shell process behind it.
//
// Wails has no API for adding a webview to a window, but it hands over the
// window itself, so each surface is a webview placed inside it. Frames go in
// page coordinates and the Go side converts them.
//
// Modals: DOM cannot be drawn over a native view, so a [data-native-modal]
// element is handed to a view of its own, created after the surfaces and
// therefore above them.
// The asset server logs every path it is asked for, so these report what
// happened without needing a console.

// Wails names a bound method by its package path, its type and its own name.
// The package here is main, and ServiceName() in surfaces.go prints the same.
const SERVICE = "main.Surfaces";

// What each kind of surface shows.
const SURFACE_URL = {
  browser: () => "https://www.google.com",
  terminal: (id) => `/terminal.html?id=${encodeURIComponent(id)}`,
};

/** The four channels of a computed CSS colour; alpha defaults to opaque. */
function rgba(css) {
  const n = (css.match(/[\d.]+/g) ?? []).map(Number);
  return [n[0] || 0, n[1] || 0, n[2] || 0, n[3] === undefined ? 1 : n[3]];
}

/**
 * A colour laid over another, as an opaque colour.
 *
 * The page's colours are partly transparent and in the page they land on the
 * plane behind them. A modal drawn natively lands on whatever the surface below
 * is showing, so a translucent border washes out over a white page.
 */
function over(colour, ground) {
  const [r, g, b, a] = rgba(colour);
  const [br, bg, bb] = rgba(ground);
  const mix = (c, d) => Math.round(c * a + d * (1 - a));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
}

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

// The bridge is not always in place when this script runs, so the host installs
// itself as soon as it is. Commits made before then are simulated, and the page
// switches over on the next one.
function install(call) {
  let last = "";

  window.hostSurfaces = {
    kinds: ["browser", "terminal"],

    theme(values) {
      call.ByName(`${SERVICE}.SetTheme`, values).catch((e) =>
        console.error("SetTheme", e),
      );
    },

    place(record) {
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
      const request = {
        viewport: { h: window.innerHeight },
        surfaces,
      };
      const key = JSON.stringify(request);
      if (key === last) return;
      last = key;

      call.ByName(`${SERVICE}.SyncSurfaces`, request).catch((e) =>
        console.error("SyncSurfaces", e),
      );
    },
  };

  // A surface is a native view, so a press on it never reaches this document.
  // The app locates it and names the surface; focus then moves exactly as it
  // does when a card is pressed. An event carries what was emitted in `data`,
  // and nothing else.
  window.wails.Events.On("surface-pressed", (e) => window.focusSurface(e.data));

  let pick = null;
  let shown = null;
  window.wails.Events.On("overlay-pick", (e) => {
    const done = pick;
    pick = null;
    if (done) done(e.data.key);
  });

  window.hostOverlay = {
    show(el, rect, onPick) {
      pick = onPick;
      // The view is named after the element, so an element without an id has
      // no name. Two of them would share one view.
      if (!el.id) throw new Error("a [data-native-modal] element needs an id");
      shown = el.id;
      const style = getComputedStyle(el);
      call.ByName(`${SERVICE}.OverlayShow`, {
        id: shown,
        viewport: { h: window.innerHeight },
        rect: toPage(rect),
        className: el.className,
        html: el.innerHTML,
        css: [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n"),
        border: over(style.borderTopColor, style.backgroundColor),
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        background: rgba(style.backgroundColor).slice(0, 3),
      }).catch((e) => console.error("OverlayShow", e));
    },

    hide() {
      const id = shown;
      shown = null;
      pick = null;
      if (id) {
        call.ByName(`${SERVICE}.OverlayHide`, id).catch((e) =>
          console.error("OverlayHide", e),
        );
      }
    },
  };
}

(function await_bridge(tries = 0) {
  if (window.wails?.Call) return install(window.wails.Call);
  if (tries > 100) return void console.error("no Wails bridge");
  setTimeout(() => await_bridge(tries + 1), 20);
})();
