// Callable wrapper for the 'processLead' backend function.
import { functions } from '@/api/client';
export const processLead = (body = {}) => functions.invoke('processLead', body);
export default processLead;
