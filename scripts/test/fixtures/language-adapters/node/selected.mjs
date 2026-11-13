import { test, describe, it } from 'node:test';
describe("selected suite", () => { it("selected case", () => {}); }); test("other", () => { throw new Error("unselected"); });
