// Callable wrapper for the 'spec' backend function.
import { functions } from '@/api/client';
export const spec = (body = {}) => functions.invoke('spec', body);
export default spec;
