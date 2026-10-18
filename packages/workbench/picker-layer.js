// The content of the picker layer. It draws one question line and, for each group, the title (if any) and the items. A title does not receive presses, and the chosen index counts only
// items (docs/spec/example-model.md#card-fullscreen). plane.js does the positioning and the opening and closing.

/**
 * Empties el, draws the question ask and the groups groups, and returns the item keys in choosing order.
 *
 *   groups  [{ heading: null | { id, name, depth, map }, items: [{ key, name, mark, svg, viewBox?, active?, notice?, expose? }] }]
 *           map is the SVG content of the group title icon, and depth is the indentation level of the title.
 *           expose is the dom name of an item that has its own, such as an item of the tab context menu.
 *   mark    (button, index, item) attaches the choose command to an item button.
 *
 * Item names and titles are set with `textContent`. A tab title is user input, so inserting it as markup could change the layer structure.
 */
export function fillPicker(el, ask, groups, mark) {
  const document = el.ownerDocument;
  el.textContent = "";
  const head = document.createElement("div");
  head.className = "picker__head";
  head.textContent = ask;
  el.appendChild(head);
  const keys = [];
  for (const { heading, items } of groups) {
    if (heading) {
      const title = document.createElement("div");
      title.className = "picker__group";
      title.dataset.group = heading.id;
      title.style.setProperty("--depth", String(heading.depth));
      title.innerHTML = `<svg data-expose="core.picker.group-icon" viewBox="0 0 16 10" aria-hidden="true">${heading.map}</svg>` +
        '<span class="picker__group-name" data-expose="core.picker.group-name"></span>';
      title.querySelector(".picker__group-name").textContent = heading.name;
      el.appendChild(title);
    }
    for (const item of items) {
      const b = document.createElement("button");
      b.className = "picker__item";
      // default: an item without its own dom name is a picker item.
      b.dataset.expose = item.expose ?? "core.picker.item";
      b.type = "button";
      b.dataset.key = item.key;
      b.dataset.active = String(item.active === true);
      if (heading) {
        b.dataset.group = heading.id;
        b.style.setProperty("--depth", String(heading.depth));
      }
      // default: a plugin mark is a 16-unit icon, and only an item that passes an icon of another size also gives a viewBox.
      const box = item.viewBox === undefined ? "0 0 16 16" : item.viewBox;
      b.innerHTML = `<svg data-expose="core.picker.item-icon" viewBox="${box}" aria-hidden="true">${item.svg}</svg>` +
        '<span class="picker__name" data-expose="core.picker.item-name"></span><small></small>';
      b.querySelector(".picker__name").textContent = item.name;
      b.querySelector("small").textContent = item.mark;
      mark(b, keys.length, item);
      keys.push(item.key);
      el.appendChild(b);
    }
  }
  return keys;
}

/** The state of a drawn item. The group of an item without a group is null. */
export function pickerItems(el) {
  return [...el.querySelectorAll(".picker__item")].map((b) => ({
    key: b.dataset.key,
    name: b.querySelector(".picker__name").textContent,
    active: b.dataset.active === "true",
    group: b.dataset.group === undefined ? null : b.dataset.group,
  }));
}

const columnX = (node, origin) => Math.round((node.getBoundingClientRect().left - origin) * 100) / 100;

/**
 * The columns of the drawn headings and items: the x of the icon and of the name of each, relative to the left edge of the
 * picker. The main document hides the picker once the native view draws it, so the columns are measured while the layout is
 * alive and kept in the status.
 */
export function pickerColumns(el) {
  const origin = el.getBoundingClientRect().left;
  const of = (row, icon, name) => ({ icon: columnX(row.querySelector(`[data-expose="${icon}"]`), origin), name: columnX(row.querySelector(`[data-expose="${name}"]`), origin) });
  return {
    groups: [...el.querySelectorAll(".picker__group")].map((g) => of(g, "core.picker.group-icon", "core.picker.group-name")),
    items: [...el.querySelectorAll(".picker__item")].map((b) => of(b, "core.picker.item-icon", "core.picker.item-name")),
  };
}

/** The state of a drawn group title. Titles are in drawing order, and depth is the indentation level. */
export function pickerGroups(el) {
  return [...el.querySelectorAll(".picker__group")].map((g) => ({
    id: g.dataset.group,
    name: g.querySelector(".picker__group-name").textContent,
    depth: Number(g.style.getPropertyValue("--depth")),
  }));
}
