// 레일 외곽선은 판의 CSS 픽셀에 그린다.
//
// SVG 요소에 좌표계(viewBox)를 두면 그 좌표계는 요소의 상자에 맞춰진다. 창이 커지면 요소는 판을 따라
// 먼저 커지고, 다시 그리기 전까지 이전 경로가 그 상자에 맞춰 옮겨지거나 늘어난다. 그 동안 카드는 아직
// 이전 자리에 있으므로, 외곽선만 카드보다 먼저 움직인 화면이 보인다. 좌표계를 두지 않으면 경로의 수는
// CSS 픽셀이고, 요소의 상자가 바뀌어도 경로는 다시 그릴 때까지 제자리에 있다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("the rail outline is drawn in the plane's CSS pixels", () => {
  const { document } = new JSDOM(source("index.html")).window;
  const rail = document.getElementById("rail");
  assert.ok(rail, "the plane holds no rail outline");
  assert.equal(rail.getAttribute("viewBox"), null,
    "a viewBox scales the outline with the element, which moves it before the cards move");
  assert.ok(!/setAttribute\(\s*["']viewBox["']/.test(source("plane.js")),
    "the plane gives the outline a coordinate system that scales with its element");
});
