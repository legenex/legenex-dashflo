// Callable wrapper for the 'testCapiConnector' backend function.
import { functions } from '@/api/client';
export const testCapiConnector = (body = {}) => functions.invoke('testCapiConnector', body);
export default testCapiConnector;
