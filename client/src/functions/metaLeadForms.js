// Callable wrapper for the 'metaLeadForms' backend function.
import { functions } from '@/api/client';
export const metaLeadForms = (body = {}) => functions.invoke('metaLeadForms', body);
export default metaLeadForms;
