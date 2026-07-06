// Callable wrapper for the 'categorizeTransactions' backend function.
import { functions } from '@/api/client';
export const categorizeTransactions = (body = {}) => functions.invoke('categorizeTransactions', body);
export default categorizeTransactions;
