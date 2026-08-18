// What the operator is told a migration import is doing.
//
// Every stage here corresponds to a real phase of the implementation. Nothing
// advances on a timer, and no percentage is invented: the upload figure is the
// browser's own byte count, and the server figure is the share of chunks it has
// actually decrypted. When there is no real number to show, this says so by
// leaving the percentage null rather than by drawing a bar that is guessing.

export const UPLOAD_SHARE = 0.35;

// Stage copy. The keys match the server's stage names plus the two the browser
// owns, because only the browser knows about the upload.
const STAGE_COPY = {
  preparing: { label: 'Preparing upload', detail: 'Reading the selected package.' },
  uploading: { label: 'Uploading encrypted package', detail: 'The package is still encrypted in transit.' },
  uploaded: { label: 'Upload complete', detail: 'Waiting for the server to start reading it.' },
  received: { label: 'Upload received', detail: 'The server has the package.' },
  parsing: { label: 'Reading migration envelope', detail: 'Parsing the outer package structure.' },
  validating_envelope: { label: 'Checking crypto parameters', detail: 'Confirming the package uses a supported envelope.' },
  deriving_key: { label: 'Deriving decryption key', detail: 'Running PBKDF2 over the passphrase. This is deliberately slow.' },
  decrypting: { label: 'Decrypting migration package', detail: 'Each chunk is authenticated and digest checked.' },
  validating: { label: 'Validating package', detail: 'Comparing records against the DashFlo schema.' },
  building_preview: { label: 'Building preview', detail: 'Summarising what an apply would change.' },
  applying: { label: 'Importing records', detail: 'Writing inside a single database transaction.' },
  complete: { label: 'Complete', detail: '' },
};

export function stageCopy(stage) {
  return STAGE_COPY[stage] || { label: 'Working', detail: '' };
}

// The browser owns the first slice of the bar because it owns the upload; the
// server's own percentage is folded into the rest. Returning null means honestly
// unknown, and the caller shows an indeterminate bar.
export function migrationPercent({ phase, uploadLoaded = 0, uploadTotal = 0, serverPercent = null }) {
  if (phase === 'uploading') {
    if (!uploadTotal) return null;
    return Math.min(Math.round((uploadLoaded / uploadTotal) * UPLOAD_SHARE * 100), Math.round(UPLOAD_SHARE * 100));
  }
  if (phase === 'complete') return 100;
  if (serverPercent === null || serverPercent === undefined) return null;
  const server = Math.max(0, Math.min(Number(serverPercent), 100));
  return Math.round((UPLOAD_SHARE + ((server / 100) * (1 - UPLOAD_SHARE))) * 100);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// The one-line count under the bar. Chunks when the server is decrypting,
// bytes while the package is going up, and nothing when neither is measurable.
export function migrationCounts(state) {
  if (state.phase === 'uploading' && state.uploadTotal) {
    return `${formatBytes(state.uploadLoaded)} / ${formatBytes(state.uploadTotal)}`;
  }
  if (state.stage === 'decrypting' && state.totalChunks) {
    return `${state.processedChunks} / ${state.totalChunks} chunks`;
  }
  return '';
}
