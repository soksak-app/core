// 표면이 알린 탭 제목, 하단 글과 작업 디렉터리(docs/spec/plugins.md#tab-reports). 레이아웃에 저장하지 않는다.
const labels = new Map();
const footers = new Map();
const directories = new Map();
const origins = new Map();
const notices = new Map();
const noticePolicies = new Map();
const modified = new Set();
// 탭이 보이는지(포커스된 카드의 활성 탭인지) 판이 알려 준다.
let visibleTab = () => false;
const listeners = new Set();

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NOTICE_POLICIES = new Set(["tab", "system"]);

function notify() {
  for (const listener of listeners) listener();
}

/** 탭 id 의 표면이 보일 제목을 정하거나(text) 지운다(null). */
export function reportTitle(tabId, text) {
  if (text === null) {
    if (labels.delete(tabId)) notify();
    return;
  }
  if (typeof text !== "string" || text.length === 0 || text.length > 256 || CONTROL.test(text)) {
    throw new TypeError("a tab title must be 1 to 256 characters without control characters");
  }
  if (labels.get(tabId) === text) return;
  labels.set(tabId, text);
  notify();
}

/** Records whether the surface of tabId holds unsaved changes (docs/spec/plugins.md#tab-reports). */
export function reportModified(tabId, value) {
  if (typeof value !== "boolean") throw new TypeError("a modified state must be true or false");
  if (modified.has(tabId) === value) return;
  if (value) modified.add(tabId);
  else modified.delete(tabId);
  notify();
}

/** Whether the surface of tabId holds unsaved changes. */
export const tabModified = (tabId) => modified.has(tabId);

/** 판이 탭이 보이는지 판단하는 함수를 정한다. */
export function setVisibleTab(probe) {
  visibleTab = probe;
}

/** 보이지 않는 탭에 알림을 둔다. 보이는 탭이면 표면이 이미 보이므로 아무것도 바꾸지 않는다. */
export function reportNotice(tabId, text, policy = "tab") {
  if (typeof text !== "string" || text.length === 0 || text.length > 1024 || CONTROL.test(text)) {
    throw new TypeError("a tab notice must be 1 to 1024 characters without control characters");
  }
  if (!NOTICE_POLICIES.has(policy)) throw new TypeError(`unknown tab notice policy: ${String(policy)}`);
  if (visibleTab(tabId)) return;
  if (notices.get(tabId) === text && noticePolicies.get(tabId) === policy) return;
  notices.set(tabId, text);
  noticePolicies.set(tabId, policy);
  notify();
}

// 기본값: 알림이 없는 탭은 null 이다.
export const tabNotice = (tabId) => noticePolicies.get(tabId) === "system" ? null : (notices.get(tabId) ?? null);

/** 모든 탭 알림의 [탭 id, 텍스트] 목록. */
export const tabNotices = () => [...notices].filter(([tabId]) => noticePolicies.get(tabId) === "system");

/** 보이게 된 탭의 알림을 지운다. 판이 그릴 때마다 부른다. */
export function clearVisibleNotices() {
  let removed = false;
  for (const tabId of [...notices.keys()]) {
    if (visibleTab(tabId)) removed = notices.delete(tabId) || removed;
  }
  if (removed) notify();
}

/** 탭 id 의 표면이 카드 내용 발에 보일 글을 정하거나(text) 지운다(null). */
export function reportFooter(tabId, text) {
  if (text === null) {
    if (footers.delete(tabId)) notify();
    return;
  }
  if (typeof text !== "string" || text.length === 0 || text.length > 1024 || CONTROL.test(text)) {
    throw new TypeError("a tab footer must be 1 to 1024 characters without control characters");
  }
  if (footers.get(tabId) === text) return;
  footers.set(tabId, text);
  notify();
}

// 기본값: 하단 글을 알리지 않은 탭은 null 이다.
export const tabFooter = (tabId) => footers.get(tabId) ?? null;

/** 탭 id 의 표면의 작업 디렉터리를 기록하거나(path) 지운다(null). */
export function reportDirectory(tabId, path) {
  if (path === null) {
    directories.delete(tabId);
    return;
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("a tab directory must be an absolute path");
  }
  directories.set(tabId, path);
}

// 기본값: 제목을 알리지 않은 탭은 null 이다.
export const tabLabel = (tabId) => labels.get(tabId) ?? null;

/** 새 탭의 출처: 탭을 더하거나 쪼갠 카드의 활성 탭이 그 순간 기록한 디렉터리. */
export function recordOrigin(tabId, fromTabId) {
  // 기본값: 위 주석대로 출처 탭이 없거나 디렉터리를 기록하지 않았으면 디렉터리가 없다(null).
  origins.set(tabId, Object.freeze({ directory: (fromTabId && directories.get(fromTabId)) ?? null }));
}

// 기본값: 출처를 기록하지 않은 탭은 디렉터리가 없다.
export const tabOrigin = (tabId) => origins.get(tabId) ?? Object.freeze({ directory: null });

/** 표면을 해제하면 그 탭의 알림도 지운다. */
export function forgetTab(tabId) {
  directories.delete(tabId);
  origins.delete(tabId);
  const noticed = notices.delete(tabId);
  noticePolicies.delete(tabId);
  const footed = footers.delete(tabId);
  const unsaved = modified.delete(tabId);
  if (labels.delete(tabId) || noticed || footed || unsaved) notify();
}

export function onTabReports(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
