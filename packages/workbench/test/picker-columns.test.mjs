import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { fillPicker } from "../picker-layer.js";

// 묶음 목록(스페이스 앱)의 제목과 항목은 아이콘 칸의 x 와 이름의 x 가 같다(docs/spec/example-model.md).
// jsdom 은 var() 를 계산하지 않으므로 app.css 의 선언을 읽어 칸의 x 를 직접 계산한다.
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

// var() 를 풀어 px 값으로 계산한다. 정의되지 않은 변수와 해석하지 못하는 식은 오류다.
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
