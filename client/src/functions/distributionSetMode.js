// Callable wrapper for the 'distributionSetMode' backend function.
import { functions } from '@/api/client';
export const distributionSetMode = (body = {}) => functions.invoke('distributionSetMode', body);
export default distributionSetMode;
