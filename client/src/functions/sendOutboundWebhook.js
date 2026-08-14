// Callable wrapper for the 'sendOutboundWebhook' backend function.
import { functions } from '@/api/client';
export const sendOutboundWebhook = (body = {}) => functions.invoke('sendOutboundWebhook', body);
export default sendOutboundWebhook;
