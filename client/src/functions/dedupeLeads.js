// Callable wrapper for the 'dedupeLeads' backend function.
import { functions } from '@/api/client';
export const dedupeLeads = (body = {}) => functions.invoke('dedupeLeads', body);
export default dedupeLeads;
