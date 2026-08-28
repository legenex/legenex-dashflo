// Callable wrapper for the 'resubmitLead' backend function.
//
// Pass { id } to resubmit one lead, or { ids: [...] } for bulk. The server
// resolves the supplier's current credential itself; the browser never
// touches a raw API key. See server/src/functions/resubmitLead.js.
import { functions } from '@/api/client';
export const resubmitLead = (body = {}) => functions.invoke('resubmitLead', body);
export default resubmitLead;
