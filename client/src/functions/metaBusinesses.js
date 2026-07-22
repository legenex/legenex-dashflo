// Callable wrapper for the 'metaBusinesses' backend function.
import { functions } from '@/api/client';
export const metaBusinesses = (body = {}) => functions.invoke('metaBusinesses', body);
export default metaBusinesses;
