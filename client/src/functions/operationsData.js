// Callable wrapper for the 'operationsData' backend function.
import { functions } from '@/api/client';
export const operationsData = (body = {}) => functions.invoke('operationsData', body);
export default operationsData;
