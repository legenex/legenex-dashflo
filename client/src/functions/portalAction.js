// Callable wrapper for the 'portalAction' backend function.
import { functions } from '@/api/client';
export const portalAction = (body = {}) => functions.invoke('portalAction', body);
export default portalAction;
