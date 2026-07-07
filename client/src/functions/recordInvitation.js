// Callable wrapper for the 'recordInvitation' backend function.
import { functions } from '@/api/client';
export const recordInvitation = (body = {}) => functions.invoke('recordInvitation', body);
export default recordInvitation;
