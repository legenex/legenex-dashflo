// Callable wrapper for the 'validate' backend function.
import { functions } from '@/api/client';
export const validate = (body = {}) => functions.invoke('validate', body);
export default validate;
