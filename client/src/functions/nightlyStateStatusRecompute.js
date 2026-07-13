// Callable wrapper for the 'nightlyStateStatusRecompute' backend function.
import { functions } from '@/api/client';
export const nightlyStateStatusRecompute = (body = {}) => functions.invoke('nightlyStateStatusRecompute', body);
export default nightlyStateStatusRecompute;
