// Callable wrapper for the 'saveMetaConnection' backend function.
import { functions } from '@/api/client';
export const saveMetaConnection = (body = {}) => functions.invoke('saveMetaConnection', body);
export default saveMetaConnection;
