// Callable wrapper for the 'metaAdAccountsOverview' backend function.
import { functions } from '@/api/client';
export const metaAdAccountsOverview = (body = {}) => functions.invoke('metaAdAccountsOverview', body);
export default metaAdAccountsOverview;
