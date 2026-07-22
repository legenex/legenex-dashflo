// Callable wrapper for the 'metaConnectionStatus' backend function.
import { functions } from '@/api/client';
export const metaConnectionStatus = (body = {}) => functions.invoke('metaConnectionStatus', body);
export default metaConnectionStatus;
