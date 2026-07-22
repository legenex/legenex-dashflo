// Callable wrapper for the 'registerMetaAdAccounts' backend function.
import { functions } from '@/api/client';
export const registerMetaAdAccounts = (body = {}) => functions.invoke('registerMetaAdAccounts', body);
export default registerMetaAdAccounts;
