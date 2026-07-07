// Callable wrapper for the 'cancelInvitation' backend function.
import { functions } from '@/api/client';
export const cancelInvitation = (body = {}) => functions.invoke('cancelInvitation', body);
export default cancelInvitation;
