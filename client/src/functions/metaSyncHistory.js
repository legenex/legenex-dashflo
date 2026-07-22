// Callable wrapper for the 'metaSyncHistory' backend function.
import { functions } from '@/api/client';
export const metaSyncHistory = (body = {}) => functions.invoke('metaSyncHistory', body);
export default metaSyncHistory;
