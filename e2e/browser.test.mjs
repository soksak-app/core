// Checks that the document region of the browser surface opens a document of the local HTTP server that the check starts, moves through the history, receives native
// input, is laid out along the surface, and closes with the surface.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The application menu is built from one ko/en table, so the check also follows the menu language.
const MENU_TITLES = {
  ko: { menu: "보기", larger: "글자 크게" },
  en: { menu: "View", larger: "Bigger Text" },
};
const largerTitle = async (s) => MENU_TITLES[(await s.get("host.menu")).language] ?? MENU_TITLES.en;


import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

/** A red block of CSS size 120x60 placed at the upper left of the block document. Its pixels grow with the page zoom. */
const BLOCK = '<div style="position:absolute;left:0;top:0;width:120px;height:60px;background:rgb(220,30,30)"></div>';

/** Measures the pixel width and height of the red block in the document region. */
async function blockSize(s, surface) {
  const { rect } = await placed(s, surface, "block document");
  const { displayed } = await s.presented();
  await s.request("diagnostics.capture.start", {});
  const result = await s.request("diagnostics.capture.stop", { after: displayed });
  try {
    const files = frames(result.frames);
    assert.ok(files.length > 0, "block capture produced no frames");
    const frame = readFrame(files.at(-1));
    const scale = frame.scale;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = Math.round(rect.y * scale); y < Math.round((rect.y + rect.height) * scale) && y < frame.height; y++) {
      for (let x = Math.round(rect.x * scale); x < Math.round((rect.x + rect.width) * scale) && x < frame.width; x++) {
        const [r, g, b] = pixel(frame, x, y);
        if (r >= 180 && g <= 80 && b <= 80) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    assert.ok(maxX >= minX, "the red block was not found in the document pixels");
    return { width: maxX - minX + 1, height: maxY - minY + 1, rect };
  } finally {
    rmSync(result.frames, { recursive: true, force: true });
  }
}

/** A loopback server that serves a long document whose title is the path name. It is closed when the check ends. */
async function serve(s) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1) || "index";
    const url = new URL(request.url, "http://127.0.0.1");
    // set-cookie stores the value of the query as the cookie run, and cookie shows the cookie of the document as the title.
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (name === "set-cookie") headers["set-cookie"] = `run=${url.searchParams.get("run")}; Path=/; Max-Age=3600`;
    // fixed is a document that shows an appearance that it decides on its own, regardless of the color scheme.
    if (name === "fixed") {
      response.writeHead(200, headers);
      response.end("<!doctype html><title>fixed</title><style>:root, body { width:100%; height:100%; margin:0; background:rgb(120,60,30); }</style>");
      return;
    }
    // type has one text field at the top left and shows the keys of the keydown events that the document receives, the
    // value of the field and whether the field and the document have the focus, as its title.
    if (name === "type") {
      response.writeHead(200, headers);
      response.end('<!doctype html><title>type</title><style>body { margin:0; }</style><input id="field" style="position:absolute;left:0;top:0;width:200px;height:40px">'
        + '<script>let keys = ""; const show = () => { document.title = `keys:${keys} typed:${field.value} focus:${document.activeElement && document.activeElement.id} has:${document.hasFocus()}`; };'
        + 'addEventListener("keydown", (event) => { keys += event.key; show(); }, true); field.addEventListener("input", show); field.addEventListener("focus", show); addEventListener("focus", show); show();</script>');
      return;
    }
    if (name === "cookie") {
      response.writeHead(200, headers);
      response.end("<!doctype html><title>cookie</title><script>document.title = 'cookie:' + document.cookie</script>");
      return;
    }
    response.writeHead(200, headers);
    response.end(`<!doctype html><title>${name}</title><style>
      :root, body { width:100%; height:100%; margin:0; }
      body { background:rgb(231,233,238); color:rgb(20,24,32); }
      @media (prefers-color-scheme: dark) {
        body { background:rgb(21,28,42); color:rgb(235,238,245); }
      }
    </style>${name === "scheme" ? "<script>document.title = matchMedia('(prefers-color-scheme: dark)').matches ? 'scheme-dark' : 'scheme-light'</script>" : ""}${name === "scheme-live" ? "<script>const query = matchMedia('(prefers-color-scheme: dark)'); const report = () => { document.title = query.matches ? 'live-dark' : 'live-light'; }; query.addEventListener('change', report); report();</script>" : ""}<body>${name === "block" ? BLOCK : ""}<div style="height:6000px">${name}</div>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const LIGHT_DOCUMENT = [231, 233, 238];
const DARK_DOCUMENT = [21, 28, 42];

/** Captures and reads the real window pixels at the center of the current document region. */
async function documentPixel(s, surface, at = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })) {
  const rect = await regionRect(s, surface);
  const recording = await s.record();
  const { displayed } = await s.presented();
  const result = await recording.stop({ after: displayed });
  const files = frames(result.frames);
  assert.ok(files.length > 0, "document pixel capture produced no frames");
  const frame = readFrame(files.at(-1));
  // Window coordinates are in points and the frame is in device pixels, so the frame is multiplied by the scale.
  const point = at(rect);
  const x = Math.floor(point.x * frame.scale);
  const y = Math.floor(point.y * frame.scale);
  assert.ok(x >= 0 && y >= 0 && x < frame.width && y < frame.height,
    `document sample ${x},${y} is outside ${frame.width}×${frame.height}`);
  const value = pixel(frame, x, y);
  rmSync(result.frames, { recursive: true, force: true });
  return value;
}

const nearColour = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 3);

/** Waits until a visible browser surface registers browser.location, and returns the active surfaces. */
async function browsers(s) {
  await s.until("core.surfaces",
    (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
    "no visible browser surface registered browser.location");
  const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
  const current = await s.get("core.surfaces");
  const selected = current.filter((x) => x.visible && x.plugin === "browser" && active.has(x.surface));
  assert.ok(selected.length > 0, "current grid has no active visible browser surface");
  // A surface without an address hides its document region, so each check confirms the visibility of the region after it opens an address.
  return selected;
}

/** Waits until the document region has read the url and reported the title. The title can arrive after the reading ends. */
function loaded(s, surface, url) {
  const title = new URL(url).pathname.slice(1);
  return s.until("browser.location", (at) => at.url === url && !at.loading && at.error === null && at.title === title,
    `surface ${surface} did not load ${url} with the title ${title}`, { surface });
}

/** The rectangle of the browser.document element in window coordinates. */
async function regionRect(s, surface) {
  const rect = await s.rect("browser.document", undefined, surface);
  return { x: rect.document.x + rect.x, y: rect.document.y + rect.y, width: rect.width, height: rect.height };
}

/** The native frame is in device pixels and the rectangle of the element is in CSS pixels, so a difference of up to one device pixel is allowed. */
const DEVICE_PIXEL = 0.5;

const near = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= DEVICE_PIXEL);

/** Waits until the document region frame of host.window equals the rectangle of the element. */
async function placed(s, surface, message) {
  await s.presented();
  const rect = await regionRect(s, surface);
  const state = await s.until("host.window", (w) => w.documents.some((d) =>
    d.surface === surface && d.document === "page" && d.visible && near(d.frame, rect)),
  `${message}: the document region did not take ${JSON.stringify(rect)}`);
  return { rect, state };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser document region navigates, takes native input, and follows its surface`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    await s.run("browser.navigate", { url: at("one") }, surface);
    await loaded(s, surface, at("one"));
    await s.run("browser.navigate", { url: at("two") }, surface);
    const second = await loaded(s, surface, at("two"));
    assert.equal(second.canGoBack, true);
    assert.equal(second.canGoForward, false);

    assert.equal(await s.run("browser.back", {}, surface), true);
    assert.equal((await loaded(s, surface, at("one"))).canGoForward, true);
    assert.equal(await s.run("browser.forward", {}, surface), true);
    await loaded(s, surface, at("two"));

    // Presses the address bar with native input and types an address.
    const field = await s.rect("browser.address", undefined, surface);
    await s.click(field.document.x + field.x + field.width / 2, field.document.y + field.y + field.height / 2);
    await s.press("a", { text: at("three") });
    await s.press("Enter");
    const third = await loaded(s, surface, at("three"));
    assert.deepEqual(third.scroll, { x: 0, y: 0 });

    // The document region is at the position of the element and owns that point.
    const { rect, state } = await placed(s, surface, "after loading");
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    assert.deepEqual(await s.run("host.hit", center), { kind: "document", surface, document: "page" });

    // A native scroll moves the document by the requested distance and does not activate the app.
    await s.pointer(center.x, center.y, "scroll", { deltaY: 120 });
    // WebKit can scroll one wheel event in several steps, so the check waits until the requested distance is reached.
    const scrolled = await s.until("browser.location", (value) => value.scroll.y >= 120,
      "the document did not scroll by the requested distance", { surface });
    assert.deepEqual(scrolled.scroll, { x: 0, y: 120 });
    assert.equal((await s.get("host.window")).active, state.active, "native input must not change application activation");

    // When the surface is moved and resized, the document region follows.
    const grid = await s.get("core.grid");
    await s.run("core.boundary.move", { axis: "y", line: 1, position: grid.lines.y[1] + 40 });
    const moved = await placed(s, surface, "after the surface moved");
    assert.ok(moved.rect.y > rect.y, `the region did not move: ${rect.y} → ${moved.rect.y}`);
    await s.run("core.boundary.move", { axis: "x", line: 2, position: grid.lines.x[2] - 60 });
    const resized = await placed(s, surface, "after the surface resized");
    assert.ok(resized.rect.width < moved.rect.width, `the region did not shrink: ${moved.rect.width} → ${resized.rect.width}`);

    // Another browser surface does not receive the document state of this surface.
    const { tab } = await s.run("core.card.split", { card: grid.cards.find((c) => c.tabs.some((x) => x.id === surface)).id,
      side: "right", plugin: "browser" });
    await s.until("core.surfaces", (list) => list.some((x) => x.surface === tab && x.exposes.includes("status browser.location")),
      "the second browser surface did not register");
    const other = await s.get("browser.location", tab);
    assert.ok(!other.url.startsWith(base), `surface ${tab} received this surface's document: ${other.url}`);
    // A second surface without an address hides its document region.
    assert.equal(other.url, "", `surface ${tab} has an address: ${other.url}`);
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === tab && d.document === "page" && !d.visible),
      "the second browser without an address shows its document region");

    // When the surface is closed, the document region is closed too.
    await s.run("core.tab.close", { tab: surface });
    await s.until("host.window", (w) => !w.documents.some((d) => d.surface === surface),
      "the document region stayed after its surface closed");
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === tab),
      "closing one surface closed another surface's document region");
  });

  test(`${app.name}: a browser without an address hides its document region and shows the empty state`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    assert.equal((await s.get("browser.location", surface)).url, "", "the fresh browser surface already has an address");

    // Without an address the document region is not visible and the empty state occupies the place of the document.
    await s.presented();
    const hidden = await s.until("host.window", (w) => w.documents.some((d) => d.surface === surface && d.document === "page"),
      "the browser surface has no document region");
    const region = hidden.documents.find((d) => d.surface === surface && d.document === "page");
    assert.equal(region.visible, false, `the document region is visible without an address: ${JSON.stringify(region)}`);
    const empty = await s.rect("browser.empty", undefined, surface);
    assert.ok(empty.width > 0 && empty.height > 0, `the empty state is not shown: ${JSON.stringify(empty)}`);

    // Pressing the empty state focuses the address bar and opens the typed address.
    const point = { x: empty.document.x + empty.x + empty.width / 2, y: empty.document.y + empty.y + empty.height / 2 };
    assert.deepEqual(await s.run("host.hit", point), { kind: "page" },
      "the empty state point does not belong to the page");
    await s.click(point.x, point.y);
    // A press on the empty state focuses the address bar through the browser.address.select command. That command runs asynchronously after the press,
    // so the check confirms through core.focus that the focus has moved, and then types.
    await s.until("core.focus", (focus) => focus?.name === "browser.address" && focus.surface === surface,
      "a click on the empty state did not focus the address field");
    await s.press("a", { text: `${base}/empty` });
    await s.press("Enter");
    await loaded(s, surface, `${base}/empty`);
    await placed(s, surface, "after the first address");
    const shown = await s.rect("browser.empty", undefined, surface);
    assert.equal(shown.width * shown.height, 0, `the empty state stayed after a load: ${JSON.stringify(shown)}`);
  });

  test(`${app.name}: the address field shows each loaded address and keeps text being typed`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    // After the typed address is opened, the address bar keeps the focus.
    const field = await s.rect("browser.address", undefined, surface);
    await s.click(field.document.x + field.x + field.width / 2, field.document.y + field.y + field.height / 2);
    await s.press("a", { text: at("typed") });
    await s.press("Enter");
    await loaded(s, surface, at("typed"));
    await s.until("browser.address.text", (text) => text.focused && text.value === at("typed"),
      "the typed address is not in the focused address field", { surface });

    // A navigation that did not come from typing shows the opened address in the address bar.
    await s.run("browser.navigate", { url: at("other") }, surface);
    await loaded(s, surface, at("other"));
    await s.until("browser.address.text", (text) => text.value === at("other"),
      "the address field does not show the address opened by browser.navigate", { surface });

    // The text being typed does not change when the document state changes.
    await s.press("a", { text: "partial" });
    const typing = await s.until("browser.address.text", (text) => text.focused && text.value.endsWith("partial"),
      "the typed text did not reach the address field", { surface });
    const { rect } = await placed(s, surface, "while typing");
    await s.pointer(rect.x + rect.width / 2, rect.y + rect.height / 2, "scroll", { deltaY: 120 });
    await s.until("browser.location", (value) => value.scroll.y >= 120,
      "the document did not scroll while the address was being typed", { surface });
    assert.equal((await s.get("browser.address.text", surface)).value, typing.value,
      "a document state change replaced the text being typed");
  });

  test(`${app.name}: the browser history buttons draw the core icons at the card header button size`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const buttons = [];
    for (const name of ["browser.back", "browser.forward", "browser.reload"]) {
      const rect = await s.rect(name, undefined, surface);
      assert.deepEqual([rect.width, rect.height], [20, 20], `${name} is not a 20×20 card header button: ${JSON.stringify(rect)}`);
      buttons.push({ name, x: rect.document.x + rect.x, y: rect.document.y + rect.y });
    }

    /** The number of pixels inside the button that differ from the button corner pixel, and the corner pixel. */
    const ink = async ({ x, y }) => {
      const { displayed } = await s.presented();
      await s.request("diagnostics.capture.start", {});
      const result = await s.request("diagnostics.capture.stop", { after: displayed });
      try {
        const files = frames(result.frames);
        assert.ok(files.length > 0, "button capture produced no frames");
        const frame = readFrame(files.at(-1));
        const k = frame.scale;
        const corner = pixel(frame, Math.round((x + 1) * k), Math.round((y + 1) * k));
        let count = 0;
        for (let py = Math.round((y + 3) * k); py < Math.round((y + 17) * k); py++) {
          for (let px = Math.round((x + 3) * k); px < Math.round((x + 17) * k); px++) {
            const value = pixel(frame, px, py);
            if (value.some((c, i) => Math.abs(c - corner[i]) > 20)) count++;
          }
        }
        return { count, corner, scale: k };
      } finally {
        rmSync(result.frames, { recursive: true, force: true });
      }
    };
    for (const button of buttons) {
      const measured = await ink(button);
      // The two strokes of the 14px chevron are about 12 CSS pixels long and about 1 CSS pixel thick.
      assert.ok(measured.count >= 12 * measured.scale ** 2, `${button.name} draws ${measured.count} icon pixels: ${JSON.stringify(measured)}`);
    }
  });

  test(`${app.name}: document site data lives in the configuration directory`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const run = `${process.pid}-${Date.now()}`;
    await s.run("browser.navigate", { url: `${base}/set-cookie?run=${run}` }, surface);
    await s.until("browser.location", (at) => at.url === `${base}/set-cookie?run=${run}` && !at.loading,
      "the cookie page did not load", { surface });
    await s.run("browser.navigate", { url: `${base}/cookie` }, surface);
    const read = await s.until("browser.location", (at) => at.url === `${base}/cookie` && at.title.startsWith("cookie:"),
      "the cookie page did not report its cookies", { surface });
    assert.ok(read.title.includes(`run=${run}`), `the document store did not keep the cookie: ${read.title}`);
    // The storage keeps site data inside the --config-dir of the running app (docs/spec/native-surfaces.md#document-regions).
    const directory = join(app.configDir, "document-data");
    let stat = null;
    try { stat = statSync(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.ok(stat?.isDirectory(), `the configuration directory has no document site data directory: ${directory}`);
  });

  test(`${app.name}: a new browser card opens the home setting or starts empty`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const home = `${base}/home`;

    // The home address is shown with its label on the browser plugin page of the settings window.
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    const nav = (await s.until("core.settings-modal", (modal) => modal.open &&
      modal.controls.some((c) => c.key === "nav:plugins"), "settings did not open")).controls.find((c) => c.key === "nav:plugins");
    await s.run(nav.command.name, nav.command.params);
    const plugin = (await s.until("core.settings-modal", (modal) => modal.section === "plugins" &&
      modal.controls.some((c) => c.key === "plugin:browser"), "the plugin section did not show the browser")).controls
      .find((c) => c.key === "plugin:browser");
    await s.run(plugin.command.name, plugin.command.params);
    const page = await s.until("core.settings-modal", (modal) => modal.plugin === "browser", "the browser plugin page did not open");
    assert.equal(page.rows.find((row) => row.key === "browser.home")?.name, "홈 주소", `browser rows: ${JSON.stringify(page.rows)}`);
    await s.run("core.settings.close");
    await s.until("core.settings-modal", (modal) => !modal.open, "settings did not close");

    const [browser] = await browsers(s);
    const card = (await s.get("core.grid")).cards.find((c) => c.tabs.some((x) => x.id === browser.surface)).id;
    const split = async () => {
      const { tab } = await s.run("core.card.split", { card, side: "right", plugin: "browser" });
      await s.until("core.surfaces", (list) => list.some((x) => x.surface === tab && x.exposes.includes("status browser.location")),
        "the new browser surface did not register");
      return tab;
    };

    await s.run("core.settings.set", { patch: { "browser.home": home } });
    await s.until("core.settings", (value) => value.values["browser.home"] === home && !value.saving, "browser.home was not saved");
    const opened = await split();
    await loaded(s, opened, home);
    await placed(s, opened, "the home document");

    await s.run("core.settings.set", { patch: { "browser.home": "" } });
    await s.until("core.settings", (value) => value.values["browser.home"] === "" && !value.saving, "browser.home was not cleared");
    const empty = await split();
    assert.equal((await s.get("browser.location", empty)).url, "", "a new browser card without a home has an address");
    const shown = await s.rect("browser.empty", undefined, empty);
    assert.ok(shown.width > 0 && shown.height > 0, `the new browser card does not show the empty state: ${JSON.stringify(shown)}`);
  });

  test(`${app.name}: a placement that keeps a shown document in place does not hide it`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    await s.run("browser.navigate", { url: `${base}/focus` }, surface);
    await loaded(s, surface, `${base}/focus`);
    await placed(s, surface, "focus document");
    // The default layout has no card sidebar, so inherit equals off. A common set is attached to the left of the terminal card so that
    // inherit makes the sidebar visible.
    await terminalCardSidebar(s);
    s.cleanup(() => s.run("core.card.sidebar.set", { card: "terminal", side: "left", set: "inherit" }));

    // A prepare request is applied inside the layer transaction of the window and does not appear on screen before the commit. While that, a surface that is visible on screen
    // is hidden, a press at its position goes to the page instead of the surface. Turning the inner sidebar of the terminal card off and on moves only the terminal surface
    // and the browser surface stays in place, so a layout request must not hide the browser surface.
    const log = await s.transcript();
    for (const set of ["off", "inherit", "off"]) {
      await s.run("core.card.sidebar.set", { card: "terminal", side: "left", set });
      await s.presented();
    }
    const lines = await log.stop();
    const requests = lines.map((line) => /^info page page: host syncSurfaces (\{.*\}) ->/.exec(line)).filter(Boolean)
      .map((found) => JSON.parse(found[1]));
    assert.ok(requests.length >= 3,
      `the terminal sidebar changes made ${requests.length} placement requests among ${lines.length} transcript lines:\n${lines.slice(0, 10).map((line) => line.slice(0, 200)).join("\n")}`);
    const hiding = requests.filter((request) => request.surfaces.some((item) => item.id === surface && item.visible === false));
    assert.equal(hiding.length, 0, `a placement request hid the shown browser surface: ${JSON.stringify(hiding[0])}`);
  });

  test(`${app.name}: browser document focus and isolation`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    await s.run("browser.navigate", { url: at("focus") }, surface);
    await loaded(s, surface, at("focus"));
    const first = await placed(s, surface, "focus document");
    const firstPoint = { x: first.rect.x + first.rect.width / 2, y: first.rect.y + first.rect.height / 2 };
    await s.pointer(firstPoint.x, firstPoint.y, "down");
    await s.pointer(firstPoint.x, firstPoint.y, "up");
    await s.until("host.window", (window) => window.documents.some((document) =>
      document.surface === surface && document.document === "page" && document.focused),
    "one click did not give the browser document native focus");
    await s.until("core.grid", (grid) => grid.cards.some((card) =>
      card.focused && card.tabs.some((tab) => tab.id === surface)), "one click did not select the browser card");
    await s.until("host.window", (window) => window.documents.some((document) =>
      document.surface === surface && document.document === "page" && document.visible &&
      document.frame.width > 0 && document.frame.height > 0),
    "the focused browser document did not settle after card selection");
    // Measures after every layout that the card selection created is displayed. A layout that is being prepared hides the surface.
    await s.presented();
    assert.deepEqual(await s.run("host.hit", firstPoint), { kind: "document", surface, document: "page" },
      "the click coordinate stopped hitting the focused browser document");
    await s.pointer(firstPoint.x, firstPoint.y, "scroll", { deltaY: 120 });
    await s.until("browser.location", (value) => value.scroll.y >= 120,
      "scroll did not reach the focused browser document", { surface });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    const { tab: other } = await s.run("core.card.split", { card: card.id, side: "right", plugin: "browser" });
    await s.until("core.surfaces", (list) => list.some((item) => item.surface === other &&
      item.exposes.includes("status browser.location")), "the second browser surface did not register");
    await s.run("browser.navigate", { url: at("other") }, other);
    await loaded(s, other, at("other"));
    const second = await placed(s, other, "second focus document");
    const secondPoint = { x: second.rect.x + second.rect.width / 2, y: second.rect.y + second.rect.height / 2 };
    await s.pointer(secondPoint.x, secondPoint.y, "down");
    await s.pointer(secondPoint.x, secondPoint.y, "up");
    await s.until("host.window", (window) => {
      const documents = new Map(window.documents.map((document) => [document.surface, document]));
      return documents.get(other)?.focused === true && documents.get(surface)?.focused === false;
    }, "focus did not move exclusively to the second browser document");
  });

  test(`${app.name}: browser documents follow host theme pixels for existing, new, and reloaded documents`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    await s.run("browser.navigate", { url: at("theme-existing") }, surface);
    await loaded(s, surface, at("theme-existing"));
    await placed(s, surface, "initial themed document");
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving,
      "host did not settle light theme");
    assert.ok(nearColour(await documentPixel(s, surface), LIGHT_DOCUMENT),
      "existing document did not render the light host theme");

    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme");
    assert.ok(nearColour(await documentPixel(s, surface), DARK_DOCUMENT),
      "existing document did not render the dark host theme");

    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving,
      "host did not settle light theme again");
    assert.ok(nearColour(await documentPixel(s, surface), LIGHT_DOCUMENT),
      "existing document did not return to the light host theme");

    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    const { tab: added } = await s.run("core.card.split", { card: card.id, side: "right", plugin: "browser" });
    await s.until("core.surfaces", (list) => list.some((item) => item.surface === added && item.visible &&
      item.exposes.includes("status browser.location")), "new browser document did not register");
    await s.run("browser.navigate", { url: at("theme-new") }, added);
    await loaded(s, added, at("theme-new"));
    await placed(s, added, "new themed document");
    assert.ok(nearColour(await documentPixel(s, added), LIGHT_DOCUMENT),
      "new document did not inherit the light host theme");

    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme before reload");
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.readyState === "complete", "main document did not reload");
    const restored = await browsers(s);
    const restoredSurface = restored.find((item) => item.surface === surface)?.surface ?? restored[0]?.surface;
    assert.ok(restoredSurface, "reloaded browser document did not restore");
    await loaded(s, restoredSurface, at("theme-existing"));
    await placed(s, restoredSurface, "reloaded themed document");
    const restoredPixel = await documentPixel(s, restoredSurface);
    assert.ok(nearColour(restoredPixel, DARK_DOCUMENT),
      `reloaded document did not retain the dark host theme: ${JSON.stringify(restoredPixel)}`);
  });

  test(`${app.name}: the address bar paints the card colour in light and dark modes`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    // The inner margin of the bar (directly above the address field) and the empty screen without an address are both painted with the card color (--card).
    const sample = async (mode) => {
      await s.run("core.settings.set", { patch: { mode } });
      await s.until("core.settings", (value) => value.values.mode === mode && !value.saving, `host did not settle ${mode} theme`);
      const address = await s.rect("browser.address", undefined, surface);
      const empty = await s.rect("browser.empty", undefined, surface);
      const bar = await documentPixel(s, surface, () => ({
        x: address.document.x + address.x + address.width / 2, y: address.document.y + address.y - 2,
      }));
      const card = await documentPixel(s, surface, () => ({
        x: empty.document.x + empty.x + 8, y: empty.document.y + empty.y + 8,
      }));
      assert.ok(nearColour(bar, card), `${mode}: the address bar is ${JSON.stringify(bar)}, the card colour ${JSON.stringify(card)}`);
    };
    await sample("light");
    await sample("dark");
  });

  test(`${app.name}: a site's appearance remains independent of the host theme`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    // Measures, through the title of a local document, the prefers-color-scheme that the document region receives in the app light mode.
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving, "host did not settle light theme");
    const base = await serve(s);
    await s.run("browser.navigate", { url: `${base}/scheme` }, surface);
    const scheme = (await s.until("browser.location", (value) => value.url === `${base}/scheme` && !value.loading &&
      /^scheme-(dark|light)$/.test(value.title), "the scheme document did not report its color scheme", { surface })).title;
    const site = `${base}/fixed`;
    await s.run("browser.navigate", { url: site }, surface);
    const location = await s.until("browser.location", (value) =>
      value.url === site && !value.loading && value.error === null && value.title === "fixed",
    "the fixed document did not load", { surface });
    await placed(s, surface, "fixed document");
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving,
      "host did not settle light theme for the fixed document");
    const light = await documentPixel(s, surface);
    // On failure it reports the pixels at the sample point and the corner, the owner of the point, the document region, the app mode and the document state together.
    const rect = await regionRect(s, surface);
    const sample = { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
    const measuredLight = { light, scheme, sample, hit: await s.run("host.hit", sample),
      corner: await documentPixel(s, surface, (r) => ({ x: r.x + 4, y: r.y + 4 })),
      region: (await s.get("host.window")).documents.find((d) => d.surface === surface),
      mode: (await s.get("core.settings")).values.mode,
      location: await s.get("browser.location", surface) };
    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme for the fixed document");
    const dark = await documentPixel(s, surface);
    // The contract is that the app mode does not change the appearance that a site decides on its own, and the prefers-color-scheme of the document region follows the app mode.
    assert.equal(scheme, "scheme-light", `the region did not receive the light color scheme: ${JSON.stringify(measuredLight)}`);
    assert.ok(nearColour(light, [120, 60, 30]), `the fixed document did not show its own colour: ${JSON.stringify(measuredLight)}`);
    assert.deepEqual(dark, light,
      `the site's own appearance was overwritten by the host theme: ${JSON.stringify({ ...measuredLight, dark })}`);
    assert.equal((await s.get("browser.location", surface)).url, location.url,
      "host theme change must not change the site location");
  });
}

// The page of a card receives the new color scheme in the presentation that applies the setting: the media query of the document
// changes without an input event (the document reports each change as the title).
for (const app of Object.values(APPS)) {
  test(`${app.name}: a change of the color scheme reaches the document of a browser card at once`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving, "host did not settle light theme");
    const base = await serve(s);
    await s.run("browser.navigate", { url: `${base}/scheme-live` }, surface);
    await s.until("browser.location", (value) => value.url === `${base}/scheme-live` && !value.loading && value.title === "live-light",
      "the live document did not report the light scheme", { surface });
    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("browser.location", (value) => value.title === "live-dark",
      "the document of a visible card kept the light scheme after the setting changed to dark", { surface });
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("browser.location", (value) => value.title === "live-light",
      "the document of a visible card kept the dark scheme after the setting changed to light", { surface });
  });
}

// A card that is hidden by the full screen of another card also has the new scheme when it is shown again.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a change of the color scheme reaches the document of a hidden browser card`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving, "host did not settle light theme");
    const base = await serve(s);
    await s.run("browser.navigate", { url: `${base}/scheme-live` }, surface);
    await s.until("browser.location", (value) => value.url === `${base}/scheme-live` && !value.loading && value.title === "live-light",
      "the live document did not report the light scheme", { surface });
    const grid = await s.get("core.grid");
    const { card } = await s.run("core.card.split", { card: grid.cards.find((c) => c.tabs.some((x) => x.id === surface)).id,
      side: "right", plugin: "browser" });
    await s.run("core.card.fullscreen", { card });
    await s.until("host.window", (state) => state.documents.every((item) => item.surface !== surface || !item.visible),
      "the document of the other card was not hidden by the full screen");
    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving, "host did not settle dark theme");
    await s.run("core.card.fullscreen", { card });
    await s.until("host.window", (state) => state.documents.some((item) => item.surface === surface && item.visible),
      "the document was not shown again after the full screen ended");
    await s.until("browser.location", (value) => value.title === "live-dark",
      "the document of a card that was hidden kept the light scheme after it was shown again", { surface });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser document zoom follows the pressed card's text size`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const url = `${base}/block`;
    await s.run("browser.navigate", { url }, surface);
    await loaded(s, surface, url);
    // Pressing a browser card makes that card the scope. A press changes the focus and so the layout, so the measurement follows it.
    const address = await s.rect("browser.address", undefined, surface);
    await s.click(address.document.x + address.x + address.width / 2, address.document.y + address.y + address.height / 2);
    await s.until("core.text", (value) => value.scope.kind === "card", "pressing the browser card did not make it the scope");
    const before = await blockSize(s, surface);
    // After two steps the scale is 1.25.
    const titles = await largerTitle(s);
    await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    await s.until("core.text", (value) => value.cards[card.id] === 1.25, "the browser card did not reach factor 1.25");
    const after = await blockSize(s, surface);
    assert.ok(Math.abs(after.width / before.width - 1.25) <= 0.05 && Math.abs(after.height / before.height - 1.25) <= 0.05,
      `the document block must grow by the factor: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    // blockSize measures after the region is placed at the rectangle of its own element. When the card text grows, the address bar
    // grows too, so the height of the element can shrink.
  });
}
