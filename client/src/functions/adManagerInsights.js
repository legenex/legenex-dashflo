// Callable wrapper for the 'adManagerInsights' backend function.
import { functions } from '@/api/client';
export const adManagerInsights = (body = {}) => functions.invoke('adManagerInsights', body);
export default adManagerInsights;
