// Callable wrapper for the 'upsertInvitedUser' backend function.
import { functions } from '@/api/client';
export const upsertInvitedUser = (body = {}) => functions.invoke('upsertInvitedUser', body);
export default upsertInvitedUser;
