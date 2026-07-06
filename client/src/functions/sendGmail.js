// Callable wrapper for the 'sendGmail' backend function.
import { functions } from '@/api/client';
export const sendGmail = (body = {}) => functions.invoke('sendGmail', body);
export default sendGmail;
