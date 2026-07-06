// Callable wrapper for the 'supplierPortalData' backend function.
import { functions } from '@/api/client';
export const supplierPortalData = (body = {}) => functions.invoke('supplierPortalData', body);
export default supplierPortalData;
