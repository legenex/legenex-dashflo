// Callable wrapper for the 'progressReadiness' backend function.
import { functions } from '@/api/client';
export const progressReadiness = (body = {}) => functions.invoke('progressReadiness', body);
export default progressReadiness;
