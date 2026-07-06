// Callable wrapper for the 'testEmail' backend function.
import { functions } from '@/api/client';
export const testEmail = (body = {}) => functions.invoke('testEmail', body);
export default testEmail;
