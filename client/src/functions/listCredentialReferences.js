// Callable wrapper for the 'listCredentialReferences' backend function.
import { functions } from '@/api/client';
export const listCredentialReferences = (body = {}) => functions.invoke('listCredentialReferences', body);
export default listCredentialReferences;
