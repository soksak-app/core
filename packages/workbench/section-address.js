// The control address of a dom request for core.sidebar.section.control (docs/spec/declared-ui.md, control address). The main page
// resolves an address among the elements of the dom entry, and refuses an address whose fields do not have the form of the spec.
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";

const FIELDS = ["sidebar", "section", "key", "path", "role"];
const ROLES = ["label", "expand"];

const invalid = (message) => new ExposureError(EXPOSURE_ERRORS.invalidParams, message);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The sidebar and the section that hold a control, from the markup that the workbench draws around it. */
function placeOf(element) {
  return { sidebar: element.closest("[data-sidebar]")?.dataset.sidebar, section: element.closest(".set__section")?.dataset.section };
}

/**
 * Resolves the control address {sidebar, section, key, path?, role?} among elements. A control of a list item or a tree node has
 * data-path and data-role, so its address needs both path and role; a button has neither, so its address takes neither.
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
  if (role !== undefined && !ROLES.includes(role)) throw invalid("address role must be label or expand");
  const sameKey = elements.filter((element) => {
    const place = placeOf(element);
    return place.sidebar === sidebar && place.section === section && element.dataset.key === key;
  });
  if (sameKey.length === 0) throw new ExposureError(EXPOSURE_ERRORS.noControl, "no control matches the address");
  const rowControl = sameKey.some((element) => element.dataset.role !== undefined);
  if (rowControl && (path === undefined || role === undefined)) {
    throw invalid("address of a control of a list item or a tree node requires path and role");
  }
  if (!rowControl && (path !== undefined || role !== undefined)) throw invalid("address of a button takes no path or role");
  const found = rowControl
    ? sameKey.find((element) => element.dataset.path === JSON.stringify(path) && element.dataset.role === role)
    : sameKey[0];
  if (!found) throw new ExposureError(EXPOSURE_ERRORS.noControl, "no control matches the address");
  return found;
}
