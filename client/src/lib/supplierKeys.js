// Supplier API key issuance, client side.
//
// There is exactly one way to create or rotate a supplier key and it is the
// server. Three pages used to mint their own value in the browser with
// Math.random() and then write it through the generic entity route. That was
// broken twice over:
//
//   1. Math.random() is not a cryptographic source. A supplier key
//      authenticates inbound leads, so a predictable key is an authentication
//      bypass.
//   2. entityPolicy write-denies ApiKey.key and ApiKey.key_hash, so the value
//      never reached the database. The page showed the operator a key, told
//      them to copy it, and stored a row with no credential on it. The
//      supplier could never post successfully and nothing said so.
//
// issueApiKey mints server-side from crypto.randomBytes, stores only the
// SHA-256 hash, and returns the cleartext exactly once in its own response.

import { issueApiKey } from '@/functions/issueApiKey';

function unwrap(result, fallbackMessage) {
  const data = result?.data ?? result;
  if (!data || data.success === false) {
    throw new Error(data?.error || fallbackMessage);
  }
  return data;
}

// Create a supplier key. Returns { id, key, key_prefix }; `key` is the only
// time the cleartext exists outside the server.
export async function createSupplierKey({ name, supplierId, supplierName, vertical } = {}) {
  return unwrap(
    await issueApiKey({
      op: 'create',
      type: 'supplier',
      name: name || supplierName || 'Supplier key',
      supplier_id: supplierId,
      supplier_name: supplierName || name,
      vertical,
    }),
    'Could not issue the supplier key',
  );
}

// Rotate an existing key in place. The old value stops working immediately.
export async function rotateSupplierKey(keyId) {
  return unwrap(
    await issueApiKey({ op: 'rotate', id: keyId }),
    'Could not rotate the supplier key',
  );
}

export default { createSupplierKey, rotateSupplierKey };
