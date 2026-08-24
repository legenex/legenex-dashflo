// Callable wrapper for the 'ensureDeliveryRouteMember' backend function.
import { functions } from '@/api/client';
export const ensureDeliveryRouteMember = (body = {}) => functions.invoke('ensureDeliveryRouteMember', body);
export default ensureDeliveryRouteMember;
