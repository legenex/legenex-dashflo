// Callable wrapper for the 'validateMetaToken' backend function.
import { functions } from '@/api/client';
export const validateMetaToken = (body = {}) => functions.invoke('validateMetaToken', body);
export default validateMetaToken;
