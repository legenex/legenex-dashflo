// Callable wrapper for the 'sendScheduledIntroEmails' backend function.
import { functions } from '@/api/client';
export const sendScheduledIntroEmails = (body = {}) => functions.invoke('sendScheduledIntroEmails', body);
export default sendScheduledIntroEmails;
