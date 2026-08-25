// Callable wrapper for the 'saveSubDeliveryHeaders' backend function.
import { functions } from '@/api/client';
export const saveSubDeliveryHeaders = (body = {}) => functions.invoke('saveSubDeliveryHeaders', body);
export default saveSubDeliveryHeaders;
