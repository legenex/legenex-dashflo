// Callable wrapper for the 'syncStripe' backend function.
import { functions } from '@/api/client';
export const syncStripe = (body = {}) => functions.invoke('syncStripe', body);
export default syncStripe;
