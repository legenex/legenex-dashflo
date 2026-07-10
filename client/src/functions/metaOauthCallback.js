// Callable wrapper for the 'metaOauthCallback' backend function.
import { functions } from '@/api/client';
export const metaOauthCallback = (body = {}) => functions.invoke('metaOauthCallback', body);
export default metaOauthCallback;
