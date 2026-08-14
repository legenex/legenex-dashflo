// Callable wrapper for the 'systemImport' backend function.
import { functions } from '@/api/client';
export const systemImport = (body = {}) => functions.invoke('systemImport', body);
export default systemImport;
