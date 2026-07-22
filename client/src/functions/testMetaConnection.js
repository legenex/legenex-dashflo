// Callable wrapper for the 'testMetaConnection' backend function.
import { functions } from '@/api/client';
export const testMetaConnection = (body = {}) => functions.invoke('testMetaConnection', body);
export default testMetaConnection;
