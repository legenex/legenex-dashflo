// Callable wrapper for the 'operatorData' backend function.
import { functions } from '@/api/client';
export const operatorData = (body = {}) => functions.invoke('operatorData', body);
export default operatorData;
