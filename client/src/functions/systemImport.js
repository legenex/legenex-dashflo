// Multipart migration upload. Ciphertext is sent to the server as a File;
// owner-bundle decryption happens there and the passphrase is never persisted.
import { api } from '@/api/client';

export const systemImport = ({ mode = 'preview', kind = 'ordinary', file, passphrase = '', confirmed = false } = {}) => {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  if (kind === 'owner') body.append('passphrase', passphrase);
  if (confirmed) body.append('confirmed', 'true');
  return api.request(`/migrations/${mode}`, { method: 'POST', body });
};
export default systemImport;
