// Callable wrapper for the 'renameField' backend function.
import { functions } from '@/api/client';
export const renameField = (body = {}) => functions.invoke('renameField', body);
export default renameField;
