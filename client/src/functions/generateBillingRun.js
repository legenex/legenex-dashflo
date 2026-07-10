// Callable wrapper for the 'generateBillingRun' backend function.
import { functions } from '@/api/client';
export const generateBillingRun = (body = {}) => functions.invoke('generateBillingRun', body);
export default generateBillingRun;
