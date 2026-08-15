// Callable wrapper for the 'integrationConfigStatus' backend function.
import { functions } from '@/api/client';
export const integrationConfigStatus = (body = {}) => functions.invoke('integrationConfigStatus', body);
export default integrationConfigStatus;
