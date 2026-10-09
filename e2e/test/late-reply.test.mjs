// 늦은 표면 답 검사가 애플리케이션 로그의 줄을 판정하는 방법을 검사한다(docs/spec/exposure.md#relay).
import assert from "node:assert/strict";
import test from "node:test";

import { heldRepliesSent, lateReplyFindings } from "../late-reply.mjs";

test("the observation of a late reply is found only for the closed surface", () => {
  const lines = [
    'info host exposure: exposure reply 41 of removed surface "tab-other" arrived after its request ended',
    'info host exposure: exposure reply 42 of removed surface "tab-a" arrived after its request ended',
    'info page page: held exposure replies of surface "tab-a" were sent after the surface closed (1)',
  ];
  assert.deepEqual(lateReplyFindings(lines, "tab-a"), {
    observations: ['info host exposure: exposure reply 42 of removed surface "tab-a" arrived after its request ended'],
    errors: [],
  });
});

test("an error line of the run is a finding, including the refusal of a late reply", () => {
  const lines = [
    'error page exposure reply 42: surface "tab-a" is not attached',
    "error page verify: 1 fail",
    'info host exposure: exposure reply 42 of removed surface "tab-a.b" arrived after its request ended',
  ];
  assert.deepEqual(lateReplyFindings(lines, "tab-a"), { observations: [], errors: lines.slice(0, 2) });
  assert.deepEqual(lateReplyFindings(['info host exposure: exposure reply 7 of removed surface "tab-aXb" arrived after its request ended'], "tab-a.b"),
    { observations: [], errors: [] }, "the surface name matched as a pattern");
});

test("the page line that ends the hold names the surface", () => {
  assert.equal(heldRepliesSent("tab-a", 1), 'info page page: held exposure replies of surface "tab-a" were sent after the surface closed (1)');
});
