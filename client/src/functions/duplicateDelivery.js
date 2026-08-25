// Callable wrapper for the 'duplicateDelivery' backend function.
import { functions } from '@/api/client';
export const duplicateDelivery = (body = {}) => functions.invoke('duplicateDelivery', body);
export default duplicateDelivery;
