// The correlation identifiers of an operation that starts in a document, the page or a view (docs/spec/logging.md#operation-chains).
// The form is p<page identity of the document>.<n>, where n counts the operations of that document, so the documents of one
// application assign different identifiers. The page and each view create their assigner here, so the form is kept in one place.

/**
 * Creates the assigner of the operations of the document whose page identity is page: each call starts an operation and
 * returns the list of its identifiers.
 */
export function createOperationCids(page) {
  if (typeof page !== "string" || page === "") throw new TypeError("createOperationCids requires the page identity of the document");
  let counter = 0;
  return () => {
    counter += 1;
    return [`p${page}.${counter}`];
  };
}
