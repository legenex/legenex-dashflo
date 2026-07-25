// Callable wrapper for the 'auditRun' backend function.
import { functions } from '@/api/client';
export const auditRun = (body = {}) => functions.invoke('auditRun', body);
export default auditRun;
