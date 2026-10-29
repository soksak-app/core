// The page identity of this document: a UUID that the document draws once when it evaluates this module, the value `page`
// of each of its events (docs/spec/logging.md#event). Two documents can start in the same millisecond of
// `performance.timeOrigin`, so the time origin does not identify a document; `page.start` states it as `time_origin`.
export const pageIdentity = crypto.randomUUID();
