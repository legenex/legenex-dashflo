// Callable wrapper for the 'leadbyteWebhook' backend function.
import { functions } from '@/api/client';
export const leadbyteWebhook = (body = {}) => functions.invoke('leadbyteWebhook', body);
export default leadbyteWebhook;
