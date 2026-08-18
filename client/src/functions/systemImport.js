// Multipart migration upload. Ciphertext is sent to the server as a File;
// owner-bundle decryption happens there and the passphrase is never persisted.
import { api } from '@/api/client';

// A generous deadline, not a fast one. The server derives a PBKDF2 key at the
// work factor the package itself declares, decrypts every chunk, verifies a
// digest per chunk, and then queries the database once per entity, so a large
// owner package legitimately takes minutes. This sits above the nginx read
// timeout for the migration endpoints on purpose: when nginx gives up first the
// operator gets its status code, and this only fires for a connection that
// produces nothing at all. What it rules out is the one outcome that is never
// acceptable here, a spinner that runs forever.
export const MIGRATION_TIMEOUT_MS = 900_000;

export const PROGRESS_POLL_MS = 1000;

// The id the server keys this run's progress on. Client generated so polling can
// begin while the upload is still in flight, and random so it is not guessable.
// It names a record that is still owner scoped on read, so it is not a secret
// and carries nothing about the package.
export function newProgressId() {
  const bytes = new Uint8Array(16);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const systemImport = ({
  mode = 'preview', kind = 'ordinary', file, passphrase = '', confirmed = false,
  onUploadProgress, onServerProgress,
} = {}) => {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  if (kind === 'owner') body.append('passphrase', passphrase);
  if (confirmed) body.append('confirmed', 'true');

  const wantsProgress = typeof onServerProgress === 'function' || typeof onUploadProgress === 'function';
  if (!wantsProgress) {
    return api.request(`/migrations/${mode}`, { method: 'POST', body, timeoutMs: MIGRATION_TIMEOUT_MS });
  }

  const progressId = newProgressId();
  body.append('progress_id', progressId);

  // Polling starts once the bytes are up and stops when the request settles.
  // A failed poll is never fatal: progress is a view of the work, not the work.
  let timer = null;
  const stopPolling = () => { if (timer) { clearInterval(timer); timer = null; } };
  const startPolling = () => {
    if (timer || typeof onServerProgress !== 'function') return;
    timer = setInterval(async () => {
      try {
        const state = await api.request(`/migrations/progress/${progressId}`);
        onServerProgress(state);
      } catch { /* the response itself is authoritative */ }
    }, PROGRESS_POLL_MS);
  };

  return api.upload(`/migrations/${mode}`, {
    body,
    timeoutMs: MIGRATION_TIMEOUT_MS,
    onUploadProgress: (event) => {
      if (typeof onUploadProgress === 'function') onUploadProgress(event);
      if (event.uploaded) startPolling();
    },
  }).finally(stopPolling);
};

export default systemImport;
