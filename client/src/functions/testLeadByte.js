// Callable wrapper for the 'testLeadByte' backend function.
import { functions } from '@/api/client';
export const testLeadByte = (body = {}) => functions.invoke('testLeadByte', body);
export default testLeadByte;
