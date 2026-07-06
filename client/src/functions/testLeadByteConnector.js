// Callable wrapper for the 'testLeadByteConnector' backend function.
import { functions } from '@/api/client';
export const testLeadByteConnector = (body = {}) => functions.invoke('testLeadByteConnector', body);
export default testLeadByteConnector;
