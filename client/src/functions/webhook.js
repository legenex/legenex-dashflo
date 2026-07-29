// Callable wrapper for the 'webhook' backend function.
import { functions } from '@/api/client';
export const webhook = (body = {}) => functions.invoke('webhook', body);
export default webhook;
