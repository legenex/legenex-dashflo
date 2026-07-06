// Callable wrapper for the 'integrationStatus' backend function.
import { functions } from '@/api/client';
export const integrationStatus = (body = {}) => functions.invoke('integrationStatus', body);
export default integrationStatus;
