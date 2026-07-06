// Callable wrapper for the 'buyerFeedbackWebhook' backend function.
import { functions } from '@/api/client';
export const buyerFeedbackWebhook = (body = {}) => functions.invoke('buyerFeedbackWebhook', body);
export default buyerFeedbackWebhook;
