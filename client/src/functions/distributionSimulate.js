// Callable wrapper for the 'distributionSimulate' backend function.
import { functions } from '@/api/client';
export const distributionSimulate = (body = {}) => functions.invoke('distributionSimulate', body);
export default distributionSimulate;
