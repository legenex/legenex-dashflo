// Callable wrapper for the 'migrateSource' backend function.
import { functions } from '@/api/client';
export const migrateSource = (body = {}) => functions.invoke('migrateSource', body);
export default migrateSource;
