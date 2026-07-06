// Callable wrapper for the 'callWebhook' backend function.
import { functions } from '@/api/client';
export const callWebhook = (body = {}) => functions.invoke('callWebhook', body);
export default callWebhook;
