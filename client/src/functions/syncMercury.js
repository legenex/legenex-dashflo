// Callable wrapper for the 'syncMercury' backend function.
import { functions } from '@/api/client';
export const syncMercury = (body = {}) => functions.invoke('syncMercury', body);
export default syncMercury;
