// Callable wrapper for the 'metaAssets' backend function.
import { functions } from '@/api/client';
export const metaAssets = (body = {}) => functions.invoke('metaAssets', body);
export default metaAssets;
