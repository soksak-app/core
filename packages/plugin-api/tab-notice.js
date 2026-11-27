// Validates the notice fields of the tab reports (docs/spec/plugins.md#tab-reports, docs/spec/notifications.md#plugin-notices).
// The surface context and the view call route both check a notice with these functions before the workbench receives it, so the
// rule has one source and each refusal has one text.

export const NOTICE_KINDS = Object.freeze(["success", "info", "warning", "error", "progress"]);

// The control characters: U+0000–U+001F and U+007F–U+009F.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NOTICE_FIELDS = Object.freeze(["kind", "title", "text", "action", "system"]);
const ACTION_FIELDS = Object.freeze(["label", "command", "params"]);
const PROGRESS_FIELDS = Object.freeze(["id", "progress"]);
const DONE_FIELDS = Object.freeze(["id", "kind", "title"]);

const isTitle = (value) => typeof value === "string" && value.length >= 1 && value.length <= 120 && !CONTROL.test(value);
const isText = (value) => typeof value === "string" && value.length <= 1024 && !CONTROL.test(value);

const TITLE_ERROR = "a notice title must be 1 to 120 characters without control characters";
const TEXT_ERROR = "a notice text must be 0 to 1024 characters without control characters";
const ID_ERROR = "a notice id must be a non-empty string";

// An object whose keys are the allowed fields: any other value, or a key outside the allowed ones, throws a TypeError that names
// the object (`name`) and the key.
function plainObject(value, allowed, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new TypeError(`${name} takes only ${allowed.slice(0, -1).join(", ")} and ${allowed.at(-1)}; found ${extra}`);
  return value;
}

function actionOf(value) {
  const action = plainObject(value, ACTION_FIELDS, "a notice action");
  if (typeof action.label !== "string" || action.label.length < 1 || action.label.length > 24) {
    throw new TypeError("a notice action label must be 1 to 24 characters");
  }
  if (typeof action.command !== "string" || action.command === "") throw new TypeError("a notice action command must be a non-empty string");
  if (!Object.hasOwn(action, "params")) return { label: action.label, command: action.command };
  if (typeof action.params !== "object" || action.params === null || Array.isArray(action.params)) throw new TypeError("a notice action params must be an object");
  return { label: action.label, command: action.command, params: action.params };
}

/**
 * Checks the fields of a notice of tab.notify and returns them as a new object. `kind` and `title` are required; `text`, `action`
 * and `system` are optional. An absent text is no text, so the checked notice carries an empty text. Any other value, or a key that
 * is not a field of a notice, throws a TypeError.
 */
export function checkNotice(fields) {
  const notice = plainObject(fields, NOTICE_FIELDS, "a notice");
  if (!NOTICE_KINDS.includes(notice.kind)) throw new TypeError("a notice kind must be success, info, warning, error or progress");
  if (!isTitle(notice.title)) throw new TypeError(TITLE_ERROR);
  const text = Object.hasOwn(notice, "text") ? notice.text : "";
  if (!isText(text)) throw new TypeError(TEXT_ERROR);
  const checked = { kind: notice.kind, title: notice.title, text };
  if (Object.hasOwn(notice, "action")) checked.action = actionOf(notice.action);
  if (Object.hasOwn(notice, "system")) {
    if (typeof notice.system !== "boolean") throw new TypeError("a notice system must be true or false");
    checked.system = notice.system;
  }
  return checked;
}

/**
 * Checks the fields {id, progress} of tab.progress. progress is a number from 0 to 1, or null while the amount is unknown.
 */
export function checkNoticeProgress(fields) {
  const checked = plainObject(fields, PROGRESS_FIELDS, "a notice progress");
  if (typeof checked.id !== "string" || checked.id === "") throw new TypeError(ID_ERROR);
  const { progress } = checked;
  if (progress !== null && !(typeof progress === "number" && progress >= 0 && progress <= 1)) {
    throw new TypeError("a notice progress must be a number from 0 to 1, or null while the amount is unknown");
  }
  return { id: checked.id, progress };
}

/**
 * Checks the fields {id, kind, title} of tab.done. kind is success or error, and title follows the notice title rule.
 */
export function checkNoticeDone(fields) {
  const checked = plainObject(fields, DONE_FIELDS, "a finished notice");
  if (typeof checked.id !== "string" || checked.id === "") throw new TypeError(ID_ERROR);
  if (checked.kind !== "success" && checked.kind !== "error") throw new TypeError("a finished notice must be success or error");
  if (!isTitle(checked.title)) throw new TypeError(TITLE_ERROR);
  return { id: checked.id, kind: checked.kind, title: checked.title };
}
