// Callable wrapper for the 'syncMetaSpend' backend function.
import { functions } from '@/api/client';
export const syncMetaSpend = (body = {}) => functions.invoke('syncMetaSpend', body);
export default syncMetaSpend;
