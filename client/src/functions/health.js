// Callable wrapper for the 'health' backend function.
import { functions } from '@/api/client';
export const health = (body = {}) => functions.invoke('health', body);
export default health;
