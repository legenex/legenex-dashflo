// Callable wrapper for the 'recomputeStateStatus' backend function.
import { functions } from '@/api/client';
export const recomputeStateStatus = (body = {}) => functions.invoke('recomputeStateStatus', body);
export default recomputeStateStatus;
