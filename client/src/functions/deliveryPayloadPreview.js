// Callable wrapper for the 'deliveryPayloadPreview' backend function.
import { functions } from '@/api/client';
export const deliveryPayloadPreview = (body = {}) => functions.invoke('deliveryPayloadPreview', body);
export default deliveryPayloadPreview;
