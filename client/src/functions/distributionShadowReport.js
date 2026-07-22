// Callable wrapper for the 'distributionShadowReport' backend function.
import { functions } from '@/api/client';
export const distributionShadowReport = (body = {}) => functions.invoke('distributionShadowReport', body);
export default distributionShadowReport;
