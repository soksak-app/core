// The control address of a dom request for core.sidebar.section.control (docs/spec/declared-ui.md, control address). The main page
// resolves an address among the elements of the dom entry, and refuses an address whose fields do not have the form of the spec.
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";

const FIELDS = ["sidebar", "section", "key", "path", "role", "action"];
const ROLES = ["label", "expand", "action"];

const invalid = (message) => new ExposureError(EXPOSURE_ERRORS.invalidParams, message);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The sidebar and the section that hold a control, from the markup that the workbench draws around it. */
function placeOf(element) {
  return { sidebar: element.closest("[data-sidebar]")?.dataset.sidebar, section: element.closest(".set__section")?.dataset.section };
}

/**
 * Resolves the control address {sidebar, section, key, path?, role?, action?} among elements. A control of a list item or a tree node
 * has data-path and data-role, so its address needs both path and role; a tree action also needs its data-action key.
 */
export function resolveSectionControl(address, elements) {
  if (!isObject(address)) throw invalid("address must be an object");
  for (const name of Object.keys(address)) {
    if (!FIELDS.includes(name)) throw invalid(`address field ${name} is not a field of a control address`);
  }
  for (const name of ["sidebar", "section", "key"]) {
    if (typeof address[name] !== "string") throw invalid(`address ${name} must be a string`);
  }
  const { sidebar, section, key, path, role } = address;
  if (path !== undefined && (!Array.isArray(path) || !path.every((part) => typeof part === "string"))) {
    throw invalid("address path must be an array of strings");
  }
  if (role !== undefined && !ROLES.includes(role)) throw invalid("address role must be label, expand, or action");
  if (address.action !== undefined && typeof address.action !== "string") throw invalid("address action must be a string");
  if (role === "action" && address.action === undefined) throw invalid("action role requires action");
  if (role !== "action" && address.action !== undefined) throw invalid("action is only valid with role action");
  const sameKey = elements.filter((element) => {
    const place = placeOf(element);
    return place.sidebar === sidebar && place.section === section && element.dataset.key === key;
  });
  if (sameKey.length === 0) throw new ExposureError(EXPOSURE_ERRORS.noControl, "no control matches the address");
  const rootControls = sameKey.filter((element) => element.dataset.role === undefined);
  const rowControls = sameKey.filter((element) => element.dataset.role !== undefined);
  if (path === undefined && role === undefined && address.action === undefined) {
    if (rootControls.length > 1) throw invalid("address matches an ambiguous root control");
    if (rootControls.length === 1) return rootControls[0];
  }
  if (rowControls.length && (path === undefined || role === undefined)) {
    throw invalid("address of a control of a list item or a tree node requires path and role");
  }
  if (!rowControls.length && (path !== undefined || role !== undefined || address.action !== undefined)) throw invalid("address of a root control takes no path, role or action");
  const found = rowControls.length
    ? rowControls.find((element) => element.dataset.path === JSON.stringify(path) && element.dataset.role === role &&
      (role !== "action" || element.dataset.action === address.action))
    : rootControls[0];
  if (!found) throw new ExposureError(EXPOSURE_ERRORS.noControl, "no control matches the address");
  return found;
}
