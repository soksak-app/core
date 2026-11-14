import test from "node:test";
test("selected parent", async (t) => { await t.test("selected child", () => {}); }); test("other", () => { throw new Error("not selected"); });
