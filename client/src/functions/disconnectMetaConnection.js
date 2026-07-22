// Callable wrapper for the 'disconnectMetaConnection' backend function.
import { functions } from '@/api/client';
export const disconnectMetaConnection = (body = {}) => functions.invoke('disconnectMetaConnection', body);
export default disconnectMetaConnection;
