// Callable wrapper for the 'bulkDeleteLeads' backend function.
import { functions } from '@/api/client';
export const bulkDeleteLeads = (body = {}) => functions.invoke('bulkDeleteLeads', body);
export default bulkDeleteLeads;
