// The ONE place that decides whether an HTTP method sends a request body.
// Shared by directPost.js (the real send path) and the operator-facing
// Delivery editor (DeliveryEditorPage.jsx), so the editor can never show a
// payload/query-parameter section the runtime would actually ignore, and the
// runtime can never silently diverge from what the editor told the operator
// to expect. See directPost.test.js's "method-aware request semantics" suite
// for the wire-level proof; this function is what both sides evaluate.
//
// GET never sends a body. DELETE matches GET unless the SubDelivery
// explicitly opted into delete_with_body. POST/PUT/PATCH always send one.
export function methodSendsBody(method, deleteWithBody) {
  const m = String(method || 'POST').toUpperCase();
  if (m === 'GET') return false;
  if (m === 'DELETE') return deleteWithBody === true;
  return true;
}
