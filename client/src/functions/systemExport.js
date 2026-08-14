// Callable wrapper for the 'systemExport' backend function.
import { functions } from '@/api/client';
export const systemExport = (body = {}) => functions.invoke('systemExport', body);
export default systemExport;
