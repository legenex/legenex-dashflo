// Callable wrapper for the '_shared' backend function.
import { functions } from '@/api/client';
export const _shared = (body = {}) => functions.invoke('_shared', body);
export default _shared;
