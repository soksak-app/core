import test from "node:test";
test("hangs", () => new Promise((resolve) => setTimeout(resolve, 30000)));
