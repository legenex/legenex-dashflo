// Callable wrapper for the 'nativeRetryWorker' backend function.
import { functions } from '@/api/client';
export const nativeRetryWorker = (body = {}) => functions.invoke('nativeRetryWorker', body);
export default nativeRetryWorker;
