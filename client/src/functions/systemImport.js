// Multipart migration upload. Ciphertext is sent to the server as a File;
// owner-bundle decryption happens there and the passphrase is never persisted.
import { api } from '@/api/client';

// A generous deadline, not a fast one. The server derives a 600,000 iteration
// PBKDF2 key, decrypts every chunk, verifies a digest per chunk, and then queries
// the database once per entity, so a large owner package legitimately takes
// minutes. This sits above the 300 second nginx read timeout on purpose: when
// nginx gives up first the operator gets its status code, and this only fires
// for a connection that produces nothing at all. What it rules out is the one
// outcome that is never acceptable here, a spinner that runs forever.
export const MIGRATION_TIMEOUT_MS = 360_000;

export const systemImport = ({ mode = 'preview', kind = 'ordinary', file, passphrase = '', confirmed = false } = {}) => {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  if (kind === 'owner') body.append('passphrase', passphrase);
  if (confirmed) body.append('confirmed', 'true');
  return api.request(`/migrations/${mode}`, { method: 'POST', body, timeoutMs: MIGRATION_TIMEOUT_MS });
};
export default systemImport;
