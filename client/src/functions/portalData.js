// Callable wrapper for the 'portalData' backend function.
import { functions } from '@/api/client';
export const portalData = (body = {}) => functions.invoke('portalData', body);
export default portalData;
