// Callable wrapper for the 'contract' backend function.
import { functions } from '@/api/client';
export const contract = (body = {}) => functions.invoke('contract', body);
export default contract;
