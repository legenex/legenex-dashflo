// Callable wrapper for the 'testWebhookDelivery' backend function.
import { functions } from '@/api/client';
export const testWebhookDelivery = (body = {}) => functions.invoke('testWebhookDelivery', body);
export default testWebhookDelivery;
