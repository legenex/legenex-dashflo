// Callable wrapper for the 'syncXero' backend function.
import { functions } from '@/api/client';
export const syncXero = (body = {}) => functions.invoke('syncXero', body);
export default syncXero;
