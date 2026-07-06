// Callable wrapper for the 'recoverTrustedForm' backend function.
import { functions } from '@/api/client';
export const recoverTrustedForm = (body = {}) => functions.invoke('recoverTrustedForm', body);
export default recoverTrustedForm;
