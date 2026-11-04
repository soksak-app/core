// The page identity of this document: a UUID that the document draws once when it evaluates this module, the value `start`
// of each of its events (docs/spec/logging.md#event). Two documents can start in the same millisecond of
// `performance.timeOrigin`, so the time origin does not identify a document; `workbench.start` states it as `started_at`.
export const pageIdentity = crypto.randomUUID();
