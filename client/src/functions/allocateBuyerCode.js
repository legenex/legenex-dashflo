// Callable wrapper for the 'allocateBuyerCode' backend function.
import { functions } from '@/api/client';
export const allocateBuyerCode = (body = {}) => functions.invoke('allocateBuyerCode', body);
export default allocateBuyerCode;
