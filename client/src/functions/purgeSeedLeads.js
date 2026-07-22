// Callable wrapper for the 'purgeSeedLeads' backend function.
import { functions } from '@/api/client';
export const purgeSeedLeads = (body = {}) => functions.invoke('purgeSeedLeads', body);
export default purgeSeedLeads;
