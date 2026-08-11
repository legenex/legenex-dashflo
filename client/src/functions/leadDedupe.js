// Callable wrapper for the 'leadDedupe' backend function.
import { functions } from '@/api/client';
export const leadDedupe = (body = {}) => functions.invoke('leadDedupe', body);
export default leadDedupe;
