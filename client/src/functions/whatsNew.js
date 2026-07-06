// Callable wrapper for the 'whatsNew' backend function.
import { functions } from '@/api/client';
export const whatsNew = (body = {}) => functions.invoke('whatsNew', body);
export default whatsNew;
