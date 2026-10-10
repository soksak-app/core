import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { fillPicker } from "../picker-layer.js";

// In the title and the items of a grouped list (the space app), the x of the icon column equals the x of the name (docs/spec/example-model.md).
// jsdom does not compute var(), so the test reads the declarations of app.css and computes the x of the column itself.
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

function declarations(selector) {
  const out = new Map();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const names = rule[1].replace(/\/\*.*?\*\//gs, "").split(",").map((s) => s.trim());
    if (!names.includes(selector)) continue;
    for (const decl of rule[2].split(";")) {
      const at = decl.indexOf(":");
      if (at > 0) out.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
    }
  }
  return out;
}

// Resolves var() and computes a px value. An undefined variable and an expression that cannot be interpreted are errors.
function px(value, vars, depth) {
  let text = value;
  for (let i = 0; i < 8 && /var\(/.test(text); i += 1) {
    text = text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
      if (name === "--depth") return String(depth);
      if (vars.has(name)) return vars.get(name);
      if (fallback !== undefined) return fallback.trim();
      throw new Error(`undefined variable ${name} in ${value}`);
    });
  }
  const expr = text.replace(/^calc\(/, "(").replace(/(\d+(?:\.\d+)?)px/g, "$1");
  if (!/^[\d\s+*().-]+$/.test(expr)) throw new Error(`cannot compute ${value}`);
  return Function(`return (${expr})`)();
}

function sides(value) {
  return value.split(/\s+(?![^()]*\))/);
}

function columns(depth) {
  const { document } = new JSDOM("<div id=picker class='picker picker--grouped'></div>").window;
  const el = document.getElementById("picker");
  fillPicker(el, "스페이스 앱 2개", [{ heading: { id: "a", name: "카드 1", depth, map: "" },
    items: [{ key: "a:t1", name: "터미널", mark: ">", svg: "<path/>" }, { key: "a:t2", name: "없는 플러그인", mark: "?", svg: "" }] }],
  () => {});
  const vars = new Map([...declarations(".picker"), ...declarations(".picker--grouped")].filter(([k]) => k.startsWith("--")));
  const x = (node, rule, iconRule, override) => {
    const own = declarations(rule);
    const box = sides(own.get("padding"));
    const left = px(declarations(override).get("padding-left") ?? box[box.length === 4 ? 3 : 1], vars,
      Number(node.style.getPropertyValue("--depth") || 0));
    const icon = px(declarations(iconRule).get("width"), vars, 0);
    const gap = px(own.get("gap"), vars, 0);
    return { icon: left, name: left + icon + gap };
  };
  return {
    heading: x(el.querySelector(".picker__group"), ".picker__group", ".picker__group svg", ".picker__group"),
    items: [...el.querySelectorAll(".picker__item")].map((b) => ({
      ...x(b, ".picker__item", ".picker__item svg", ".picker--grouped .picker__item[data-group]"), slots: b.querySelectorAll("svg").length })),
  };
}

test("the icon and the name of a heading and of its items share one column at every depth", () => {
  for (const depth of [0, 1, 2]) {
    const { heading, items } = columns(depth);
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.slots, 1, `depth ${depth}: an item keeps one icon slot even without a plugin mark`);
      assert.equal(item.icon, heading.icon, `depth ${depth}: icon column`);
      assert.equal(item.name, heading.name, `depth ${depth}: name column`);
    }
  }
});
