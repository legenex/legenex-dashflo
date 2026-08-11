// Callable wrapper for the 'aiHealth' backend function.
import { functions } from '@/api/client';
export const aiHealth = (body = {}) => functions.invoke('aiHealth', body);
export default aiHealth;
