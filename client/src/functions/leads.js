// Callable wrapper for the 'leads' backend function.
import { functions } from '@/api/client';
export const leads = (body = {}) => functions.invoke('leads', body);
export default leads;
