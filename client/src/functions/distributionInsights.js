// Callable wrapper for the 'distributionInsights' backend function.
import { functions } from '@/api/client';
export const distributionInsights = (body = {}) => functions.invoke('distributionInsights', body);
export default distributionInsights;
