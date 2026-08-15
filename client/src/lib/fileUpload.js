// Pure helpers behind the Tools file upload and paste control.
//
// The selection rules live here rather than inside ToolsDashboard.jsx so they
// can be exercised directly. The component keeps its markup and its state; it
// only delegates the decisions that are worth asserting: what counts as an
// accepted file, what was refused, and which icon a row gets.
//
// Acceptance is deliberately conservative. A browser reports a MIME type for
// most files but not all: .md and .csv frequently arrive with an empty type,
// and a file dragged from an archive tool can arrive with none at all. So a
// file is accepted when its MIME type is on the allowlist, and otherwise when
// its extension is. Anything else is refused and reported, never guessed at.

export const ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/zip',
  'application/x-zip-compressed',
  'text/markdown',
  'text/plain',
  'text/csv',
  'application/csv',
]);

export const ACCEPTED_EXTENSIONS = Object.freeze([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'zip',
  'md',
  'txt',
  'csv',
]);

// File kinds drive which icon a selected row shows. Kept as data so the icon
// choice is assertable without rendering.
export const FILE_KIND = Object.freeze({
  IMAGE: 'image',
  ARCHIVE: 'archive',
  MARKDOWN: 'markdown',
  SPREADSHEET: 'spreadsheet',
  DOCUMENT: 'document',
});

function nameOf(file) {
  return String(file?.name ?? '');
}

function typeOf(file) {
  return String(file?.type ?? '').toLowerCase();
}

// Returns the lowercased extension, or an empty string when the name carries
// no dot. "README" has no extension; "archive.tar.gz" reports "gz".
export function extensionOf(fileName) {
  const name = String(fileName ?? '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isAcceptedFile(file) {
  if (!file) return false;
  const type = typeOf(file);
  if (type) return ACCEPTED_MIME_TYPES.includes(type);
  return ACCEPTED_EXTENSIONS.includes(extensionOf(nameOf(file)));
}

// Splits a selection into what is kept and what is refused. The refused list
// exists so a caller can tell the operator what happened; dropping a file the
// operator chose without saying so is how a missing attachment goes unnoticed.
export function filterAcceptedFiles(files) {
  const list = Array.from(files ?? []);
  const accepted = [];
  const rejected = [];
  for (const file of list) {
    if (isAcceptedFile(file)) accepted.push(file);
    else rejected.push(file);
  }
  return { accepted, rejected };
}

export function fileKind(file) {
  const type = typeOf(file);
  const ext = extensionOf(nameOf(file));
  if (type.startsWith('image/')) return FILE_KIND.IMAGE;
  if (ext === 'zip' || ext === 'rar') return FILE_KIND.ARCHIVE;
  if (ext === 'md') return FILE_KIND.MARKDOWN;
  if (ext === 'csv') return FILE_KIND.SPREADSHEET;
  return FILE_KIND.DOCUMENT;
}

// A paste carries clipboard items rather than a file list. Only items whose
// kind is "file" produce one, and getAsFile can still return null, which is
// why the result is filtered rather than mapped straight through.
export function filesFromClipboard(clipboardData) {
  const items = clipboardData?.items;
  if (!items) return [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item?.kind !== 'file') continue;
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (file) out.push(file);
  }
  return out;
}

export function filesFromDrop(dataTransfer) {
  return Array.from(dataTransfer?.files ?? []);
}
