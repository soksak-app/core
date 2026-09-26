// 탭 알림을 운영체제의 알림으로 게시한다(docs/spec/plugins.md#tab-reports). 알림 목록이 바뀔 때마다 새로
// 생기거나 바뀐 알림은 게시하고, 지워진 알림은 지운다. 누른 알림은 그 탭을 고른다.
import { notificationCenter } from "./host.js";
import { onTabReports, tabNotices } from "./tab-reports.js";

/** 권한이 거부된 동안 알림 도움말의 마지막 줄. */
export const DENIED_LINE = "System notifications are turned off for this application.";

/**
 * post({surface,title,body}) 와 remove({surface}) 는 호스트 호출, notices() 는 [탭, 텍스트] 목록, tabName(탭) 은
 * 탭의 이름, select(탭) 은 core.tab.select 실행이다.
 */
export function createSystemNotifications({ post, remove, notices, tabName, select }) {
  const posted = new Map();
  // 알림 센터가 받아들인 뒤 지우지 않은 탭.
  const accepted = [];
  let current = { authorization: "notDetermined", error: null };
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const failed = (operation) => (error) => {
    // 기본값: 거부 값은 Error 가 아닐 수 있으므로 그 값 자체를 적는다.
    current = { ...current, error: `${operation}: ${error?.message ?? error}` };
    changed();
  };

  return {
    sync() {
      const now = new Map(notices());
      for (const [tab, text] of now) {
        if (posted.get(tab) === text) continue;
        posted.set(tab, text);
        post({ surface: tab, title: tabName(tab), body: text }).catch(failed("post"));
      }
      for (const tab of [...posted.keys()]) {
        if (now.has(tab)) continue;
        posted.delete(tab);
        const index = accepted.indexOf(tab);
        if (index >= 0) {
          accepted.splice(index, 1);
          changed();
        }
        remove({ surface: tab }).catch(failed("remove"));
      }
    },
    setState(state) {
      // 기본값: 호스트의 알림 상태는 오류가 있을 때만 error 를 싣는다.
      current = { authorization: state.authorization, error: state.error ?? null };
      changed();
    },
    state: () => ({ ...current, posted: [...accepted] }),
    posted({ surface }) {
      if (accepted.includes(surface) || !posted.has(surface)) return;
      accepted.push(surface);
      changed();
    },
    activated: ({ surface }) => select(surface),
    tooltip: (text) => (current.authorization === "denied" ? `${text}\n${DENIED_LINE}` : text),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* 탭 이름과 탭 고르기는 판이 정한다. */
let nameOf = (tab) => tab;
let selectTab = () => Promise.reject(new Error("no tab selection is configured"));

/** 이 창의 시스템 알림. 애플리케이션이 없으면 게시하지 않는다. */
export const systemNotifications = createSystemNotifications({
  // 기본값: 위 주석대로 호스트가 없는 브라우저 예제는 시스템 알림을 게시하지 않는다.
  post: (request) => notificationCenter?.post(request) ?? Promise.resolve(),
  // 기본값: 호스트가 없는 브라우저 예제에는 지울 시스템 알림이 없다.
  remove: (request) => notificationCenter?.remove(request) ?? Promise.resolve(),
  notices: tabNotices,
  tabName: (tab) => nameOf(tab),
  select: (tab) => selectTab(tab),
});

/** 판이 탭 이름을 찾는 함수와 core.tab.select 를 실행하는 함수를 준다. */
export function configureSystemNotifications({ tabName, select }) {
  nameOf = tabName;
  selectTab = select;
}

if (notificationCenter) {
  onTabReports(() => systemNotifications.sync());
  notificationCenter.onState((state) => systemNotifications.setState(state));
  notificationCenter.onPosted((post) => systemNotifications.posted(post));
  notificationCenter.onActivated((activation) => {
    systemNotifications.activated(activation).catch((error) =>
      // 기본값: 거부 값은 Error 가 아닐 수 있으므로 그 값 자체를 적는다.
      systemNotifications.setState({ ...systemNotifications.state(), error: `activate: ${error?.message ?? error}` }));
  });
  notificationCenter.state().then((state) => systemNotifications.setState(state),
    // 기본값: 거부 값은 Error 가 아닐 수 있으므로 그 값 자체를 적는다.
    (error) => systemNotifications.setState({ ...systemNotifications.state(), error: `state: ${error?.message ?? error}` }));
}
