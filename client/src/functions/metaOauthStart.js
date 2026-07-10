// Callable wrapper for the 'metaOauthStart' backend function.
import { functions } from '@/api/client';
export const metaOauthStart = (body = {}) => functions.invoke('metaOauthStart', body);
export default metaOauthStart;
