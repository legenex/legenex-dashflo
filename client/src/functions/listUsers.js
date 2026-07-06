// Callable wrapper for the 'listUsers' backend function.
import { functions } from '@/api/client';
export const listUsers = (body = {}) => functions.invoke('listUsers', body);
export default listUsers;
