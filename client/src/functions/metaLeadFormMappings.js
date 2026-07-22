// Callable wrapper for the 'metaLeadFormMappings' backend function.
import { functions } from '@/api/client';
export const metaLeadFormMappings = (body = {}) => functions.invoke('metaLeadFormMappings', body);
export default metaLeadFormMappings;
