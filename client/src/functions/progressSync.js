// Callable wrapper for the 'progressSync' backend function.
import { functions } from '@/api/client';
export const progressSync = (body = {}) => functions.invoke('progressSync', body);
export default progressSync;
