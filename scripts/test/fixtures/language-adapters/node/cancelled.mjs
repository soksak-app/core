import { test, describe, it } from 'node:test';
test("required", { signal: AbortSignal.abort(new Error("cancelled fixture")) }, () => {});
