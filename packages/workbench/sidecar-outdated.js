// The notices of the outdated persistent services (docs/spec/persistent-services.md#updates). The window shows one warning per service
// through the notice store (notices.js) and withdraws it when the service leaves `outdated`.
import { onPluginOperations, pluginOperations } from "./installed-plugins.js";

/** The origin of the notice of a service: each service has at most one shown notice. */
export const outdatedOrigin = (sidecar) => `sidecar-outdated:${sidecar}`;

/** The origin of the card notice of a service on one of its surfaces (docs/spec/persistent-services.md#updates). */
export const outdatedSurfaceOrigin = (sidecar, surface) => `${outdatedOrigin(sidecar)}:${surface}`;

/** The title, text and action of the warning of one entry of `outdated` of host.sidecars: {sidecar, running, installed, sessions, surfaces}. */
function outdatedWarning({ sidecar, running, installed, sessions }) {
  const title = running === null
    ? `${sidecar} 서비스가 버전 없이 실행 중이고 설치된 버전은 ${installed}다`
    : `${sidecar} ${running}이 실행 중이고 설치된 버전은 ${installed}다`;
  const text = `세션 ${sessions}개가 이 서비스를 쓰고 있다. 세션이 모두 끝나면 서비스가 자동으로 교체된다. 교체를 누르면 세션 ${sessions}개가 끝나고 설치된 버전이 시작된다.`;
  return { title, text, action: { label: "교체", command: "core.plugins.replace", params: { sidecar } } };
}

/** The app notice of one entry of `outdated` of host.sidecars. */
export function outdatedNotice(service) {
  const { title, text, action } = outdatedWarning(service);
  return { kind: "warning", title, text, source: { kind: "core" }, origin: outdatedOrigin(service.sidecar), actions: [action] };
}

/**
 * Shows the notices of a list of outdated services on the store and withdraws the notice of each service that left the list. The store
 * decides the places of each notice; a service whose notice is still shown takes the new text of the list.
 */
export function createOutdatedNotices(store, { targetOf = () => null } = {}) {
  let shown = new Set();
  return {
    reconcile(outdated) {
      const next = new Set();
      for (const service of outdated) {
        const notice = outdatedNotice(service);
        next.add(notice.origin);
        store.show(notice);
        // Each surface that holds a session of the service shows the same warning as a card notice on its tab; targetOf names the tab
        // and card of a surface, or null when the page shows no tab for it.
        const { title, text, action } = outdatedWarning(service);
        for (const surface of service.surfaces) {
          const target = targetOf(surface);
          if (target === null) continue;
          const origin = outdatedSurfaceOrigin(service.sidecar, surface);
          next.add(origin);
          store.showTab({ kind: "warning", title, text, action }, target, origin);
        }
      }
      for (const origin of shown) if (!next.has(origin)) store.withdrawOrigin(origin);
      shown = next;
    },
  };
}

/**
 * Shows the notices of the list that the plugin operation state holds (plugins.status().outdated) and re-reads the list on each change of
 * that state. The state reads host.sidecars at its start and on each sidecars-changed event and reports a failed read itself, so this
 * module makes no host call and runs no timer.
 */
export function followOutdatedSidecars({ store, targetOf, plugins = pluginOperations, subscribe = onPluginOperations }) {
  const outdated = createOutdatedNotices(store, { targetOf });
  const reconcile = () => outdated.reconcile(plugins.status().outdated);
  subscribe(reconcile);
  reconcile();
  return outdated;
}
