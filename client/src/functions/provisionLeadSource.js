// Callable wrapper for the 'provisionLeadSource' backend function.
import { functions } from '@/api/client';
export const provisionLeadSource = (body = {}) => functions.invoke('provisionLeadSource', body);
export default provisionLeadSource;
