// Callable wrapper for the 'migrateMetaConnector' backend function.
import { functions } from '@/api/client';
export const migrateMetaConnector = (body = {}) => functions.invoke('migrateMetaConnector', body);
export default migrateMetaConnector;
