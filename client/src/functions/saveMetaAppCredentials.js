// Callable wrapper for the 'saveMetaAppCredentials' backend function.
import { functions } from '@/api/client';
export const saveMetaAppCredentials = (body = {}) => functions.invoke('saveMetaAppCredentials', body);
export default saveMetaAppCredentials;
