// Callable wrapper for the 'reconInsights' backend function.
import { functions } from '@/api/client';
export const reconInsights = (body = {}) => functions.invoke('reconInsights', body);
export default reconInsights;
