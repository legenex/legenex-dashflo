// Callable wrapper for the 'sendWhatsapp' backend function.
import { functions } from '@/api/client';
export const sendWhatsapp = (body = {}) => functions.invoke('sendWhatsapp', body);
export default sendWhatsapp;
