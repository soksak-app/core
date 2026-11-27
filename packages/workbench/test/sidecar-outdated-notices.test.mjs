// The notices of the outdated persistent services (docs/spec/persistent-services.md#updates): one warning per service through the
// notice store, withdrawn when the service leaves outdated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotices } from "../notices.js";
import { createOutdatedNotices, followOutdatedSidecars, outdatedNotice } from "../sidecar-outdated.js";

function store() {
  const logs = [];
  const notices = createNotices({
    settings: (key) => ({ autoDismissProblemToasts: false, problemToastDismissSeconds: 5, quietToasts: false, noticeCenterStyle: "popover" })[key],
    view: globalThis,
    log: (level, line) => logs.push([level, line]),
  });
  return { notices, logs };
}

const service = { sidecar: "@fixture/echo", running: "0.0.6", installed: "0.0.7", sessions: 2, surfaces: [] };

test("the notice of a service with a version names both versions, its sessions and the action that ends it", () => {
  const notice = outdatedNotice(service);
  assert.equal(notice.kind, "warning");
  assert.equal(notice.title, "@fixture/echo 0.0.6이 실행 중이고 설치된 버전은 0.0.7다");
  assert.equal(notice.text, "세션 2개가 이 서비스를 쓰고 있다. 세션이 모두 끝나면 서비스가 자동으로 교체된다. 교체를 누르면 세션 2개가 끝나고 설치된 버전이 시작된다.");
  assert.deepEqual(notice.actions, [{ label: "교체", command: "core.plugins.replace", params: { sidecar: "@fixture/echo" } }]);
  assert.equal(notice.origin, "sidecar-outdated:@fixture/echo");
});

test("a service that sent no version is named without a version", () => {
  assert.equal(outdatedNotice({ ...service, running: null }).title, "@fixture/echo 서비스가 버전 없이 실행 중이고 설치된 버전은 0.0.7다");
});

test("each outdated service shows one warning, and a repeated list shows nothing new", () => {
  const { notices, logs } = store();
  const outdated = createOutdatedNotices(notices);
  const other = { sidecar: "@fixture/other", running: null, installed: "1.0.0", sessions: 0, surfaces: [] };
  outdated.reconcile([service, other]);
  outdated.reconcile([service, other]);
  assert.equal(notices.toasts().length, 2);
  assert.equal(notices.status().entries.length, 2);
  assert.deepEqual(logs.map(([level]) => level), ["info", "info"], "one log line per notice that appears");
});

test("a changed session count rewrites the shown notice of its service and keeps its count", () => {
  const { notices } = store();
  const outdated = createOutdatedNotices(notices);
  outdated.reconcile([service]);
  outdated.reconcile([{ ...service, sessions: 3 }]);
  const entries = notices.status().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 1, "a show with the same origin is the same occurrence");
  assert.match(entries[0].text, /^세션 3개가 이 서비스를 쓰고 있다/);
  assert.equal(notices.toasts().length, 1);
  assert.equal(notices.toasts()[0].title, "@fixture/echo 0.0.6이 실행 중이고 설치된 버전은 0.0.7다");
});

test("a service that leaves outdated is withdrawn and its entry stays read; the other service keeps its notice", () => {
  const { notices } = store();
  const outdated = createOutdatedNotices(notices);
  const other = { sidecar: "@fixture/other", running: "0.1.0", installed: "0.2.0", sessions: 1, surfaces: [] };
  outdated.reconcile([service, other]);
  outdated.reconcile([other]);
  assert.deepEqual(notices.toasts().map(({ title }) => title), ["@fixture/other 0.1.0이 실행 중이고 설치된 버전은 0.2.0다"]);
  const entries = notices.status().entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.title.startsWith("@fixture/echo")).read, true);
});

test("the window takes the list from the plugin operation state at its start and on each change of that state, and makes no host call", () => {
  const { notices } = store();
  let list = [service];
  let listener = null;
  let reads = 0;
  const plugins = { status: () => { reads += 1; return { outdated: list }; } };
  followOutdatedSidecars({ store: notices, plugins, subscribe: (fn) => { listener = fn; } });
  assert.equal(notices.toasts().length, 1, "the list of the state at the start is shown");
  assert.equal(reads, 1);
  list = [];
  listener();
  assert.equal(notices.toasts().length, 0, "a change that leaves the list withdraws the notice");
  assert.equal(reads, 2);
});

test("each surface of an outdated service shows its warning as a card notice on its tab, withdrawn when the surface leaves", () => {
  const { notices } = store();
  const targets = {
    "surface-1": { card: "card-a", tab: "surface-1", plugin: "plugin" },
    "surface-2": { card: "card-b", tab: "surface-2", plugin: "plugin" },
  };
  const outdated = createOutdatedNotices(notices, { targetOf: (surface) => targets[surface] ?? null });
  // A withdrawn notice keeps its center entry, read, so the cards that show a notice are the unread card entries.
  const cardsShown = () => notices.status().entries.filter((entry) => entry.source.kind === "card" && !entry.read).map((entry) => entry.source.card).sort();
  outdated.reconcile([{ ...service, surfaces: ["surface-1", "surface-2"] }]);
  assert.deepEqual(cardsShown(), ["card-a", "card-b"]);
  outdated.reconcile([{ ...service, surfaces: ["surface-1"] }]);
  assert.deepEqual(cardsShown(), ["card-a"]);
});
