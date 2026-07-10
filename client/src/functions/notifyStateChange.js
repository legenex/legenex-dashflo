// Callable wrapper for the 'notifyStateChange' backend function.
import { functions } from '@/api/client';
export const notifyStateChange = (body = {}) => functions.invoke('notifyStateChange', body);
export default notifyStateChange;
