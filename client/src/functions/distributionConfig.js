// Callable wrapper for the 'distributionConfig' backend function.
import { functions } from '@/api/client';
export const distributionConfig = (body = {}) => functions.invoke('distributionConfig', body);
export default distributionConfig;
