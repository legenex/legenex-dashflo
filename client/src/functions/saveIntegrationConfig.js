// Callable wrapper for the 'saveIntegrationConfig' backend function.
import { functions } from '@/api/client';
export const saveIntegrationConfig = (body = {}) => functions.invoke('saveIntegrationConfig', body);
export default saveIntegrationConfig;
