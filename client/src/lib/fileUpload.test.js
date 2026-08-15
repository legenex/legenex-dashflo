import { describe, it, expect } from 'vitest';

import {
  ACCEPTED_EXTENSIONS,
  ACCEPTED_MIME_TYPES,
  FILE_KIND,
  extensionOf,
  fileKind,
  filesFromClipboard,
  filesFromDrop,
  filterAcceptedFiles,
  isAcceptedFile,
} from './fileUpload.js';

// Covers the selection rules behind the Tools file upload and paste control.
//
// A browser File is a name plus a MIME type as far as these rules are
// concerned, so a plain object is a faithful stand-in. The cases that matter
// are the ones a real operator hits: a .md or .csv arriving with an empty
// type, a file with no extension at all, and something that should be refused.

const file = (name, type = '') => ({ name, type });

describe('extensionOf', () => {
  it('reads the extension, lowercased', () => {
    expect(extensionOf('notes.MD')).toBe('md');
    expect(extensionOf('shot.PNG')).toBe('png');
  });

  it('reads only the final extension', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });

  it('returns nothing for a name with no extension', () => {
    // The original rule used split('.').pop(), which returns the whole name
    // here and would then compare "readme" against the extension list.
    expect(extensionOf('README')).toBe('');
  });

  it('returns nothing for a dotfile or a trailing dot', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('survives an absent name', () => {
    expect(extensionOf(undefined)).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});

describe('isAcceptedFile', () => {
  it('accepts every advertised MIME type', () => {
    for (const type of ACCEPTED_MIME_TYPES) {
      expect(isAcceptedFile(file('anything', type)), type).toBe(true);
    }
  });

  it('accepts every advertised extension when the type is empty', () => {
    for (const ext of ACCEPTED_EXTENSIONS) {
      expect(isAcceptedFile(file(`sample.${ext}`, '')), ext).toBe(true);
    }
  });

  it('accepts an extension regardless of its case', () => {
    expect(isAcceptedFile(file('REPORT.CSV', ''))).toBe(true);
  });

  it('refuses an unlisted MIME type even when the extension looks fine', () => {
    // The type is authoritative when present. A file announcing itself as an
    // executable is refused even though it is named .txt.
    expect(isAcceptedFile(file('payload.txt', 'application/x-msdownload'))).toBe(false);
  });

  it('refuses an unlisted extension when no type is given', () => {
    expect(isAcceptedFile(file('installer.exe', ''))).toBe(false);
    expect(isAcceptedFile(file('script.sh', ''))).toBe(false);
  });

  it('refuses a file with neither a usable type nor an extension', () => {
    expect(isAcceptedFile(file('README', ''))).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isAcceptedFile(null)).toBe(false);
    expect(isAcceptedFile(undefined)).toBe(false);
  });
});

describe('filterAcceptedFiles', () => {
  it('separates what is kept from what is refused, and keeps the order', () => {
    const input = [
      file('a.png', 'image/png'),
      file('b.exe', 'application/x-msdownload'),
      file('c.csv', ''),
      file('d.sh', ''),
    ];
    const { accepted, rejected } = filterAcceptedFiles(input);
    expect(accepted.map((f) => f.name)).toEqual(['a.png', 'c.csv']);
    expect(rejected.map((f) => f.name)).toEqual(['b.exe', 'd.sh']);
  });

  it('reports refusals rather than discarding them without trace', () => {
    // This is the property worth pinning. The control is allowed to drop a
    // file, but it must be able to say which one, so a caller can tell the
    // operator instead of leaving them to notice a missing attachment later.
    const { accepted, rejected } = filterAcceptedFiles([file('installer.exe', '')]);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].name).toBe('installer.exe');
  });

  it('accepts an array-like FileList', () => {
    const fileList = { 0: file('a.txt', 'text/plain'), length: 1 };
    const { accepted } = filterAcceptedFiles(fileList);
    expect(accepted.map((f) => f.name)).toEqual(['a.txt']);
  });

  it('returns empty lists for an empty or absent selection', () => {
    expect(filterAcceptedFiles([])).toEqual({ accepted: [], rejected: [] });
    expect(filterAcceptedFiles(undefined)).toEqual({ accepted: [], rejected: [] });
  });

  it('does not deduplicate, which is why choosing one file twice lists it twice', () => {
    // Recorded as current behaviour rather than asserted as desirable. The
    // list is keyed by position and removal is by index, so duplicates are
    // consistent today; changing it is a product decision, not a silent fix.
    const twice = [file('a.png', 'image/png'), file('a.png', 'image/png')];
    expect(filterAcceptedFiles(twice).accepted).toHaveLength(2);
  });
});

describe('fileKind', () => {
  it('calls any image an image, from its type', () => {
    expect(fileKind(file('a.png', 'image/png'))).toBe(FILE_KIND.IMAGE);
    expect(fileKind(file('a.jpg', 'image/jpeg'))).toBe(FILE_KIND.IMAGE);
    expect(fileKind(file('a.gif', 'image/gif'))).toBe(FILE_KIND.IMAGE);
  });

  it('calls a zip an archive even when the type is empty', () => {
    expect(fileKind(file('bundle.zip', ''))).toBe(FILE_KIND.ARCHIVE);
    expect(fileKind(file('bundle.zip', 'application/zip'))).toBe(FILE_KIND.ARCHIVE);
  });

  it('separates markdown, csv and plain text', () => {
    expect(fileKind(file('notes.md', ''))).toBe(FILE_KIND.MARKDOWN);
    expect(fileKind(file('rows.csv', 'text/csv'))).toBe(FILE_KIND.SPREADSHEET);
    expect(fileKind(file('notes.txt', 'text/plain'))).toBe(FILE_KIND.DOCUMENT);
  });

  it('classifies by extension case-insensitively', () => {
    expect(fileKind(file('ROWS.CSV', ''))).toBe(FILE_KIND.SPREADSHEET);
    expect(fileKind(file('BUNDLE.ZIP', ''))).toBe(FILE_KIND.ARCHIVE);
  });

  it('falls back to a document rather than throwing on a typeless file', () => {
    // The original inline rule read file.type.startsWith directly, so any file
    // reaching render without a type string would have thrown mid-list.
    expect(fileKind({ name: 'mystery' })).toBe(FILE_KIND.DOCUMENT);
    expect(fileKind({})).toBe(FILE_KIND.DOCUMENT);
  });
});

describe('filesFromClipboard', () => {
  const item = (kind, value) => ({ kind, getAsFile: () => value });

  it('takes files from a paste and ignores pasted text', () => {
    const clipboardData = {
      items: [
        item('string', null),
        item('file', file('shot.png', 'image/png')),
        item('string', null),
        item('file', file('rows.csv', 'text/csv')),
      ],
    };
    expect(filesFromClipboard(clipboardData).map((f) => f.name)).toEqual(['shot.png', 'rows.csv']);
  });

  it('drops an item that claims to be a file but yields nothing', () => {
    // getAsFile can return null. The original loop pushed that null straight
    // into state, where the render then read .type off it and threw.
    const clipboardData = { items: [item('file', null)] };
    expect(filesFromClipboard(clipboardData)).toEqual([]);
  });

  it('returns nothing for a paste carrying no items', () => {
    expect(filesFromClipboard({})).toEqual([]);
    expect(filesFromClipboard(undefined)).toEqual([]);
  });
});

describe('filesFromDrop', () => {
  it('reads the dropped files', () => {
    const dataTransfer = { files: [file('a.png', 'image/png')] };
    expect(filesFromDrop(dataTransfer).map((f) => f.name)).toEqual(['a.png']);
  });

  it('returns nothing for a drop carrying no files', () => {
    expect(filesFromDrop({})).toEqual([]);
    expect(filesFromDrop(undefined)).toEqual([]);
  });
});

describe('the accept attribute and the rules agree', () => {
  // The input advertises .jpg,.jpeg,.png,.gif,.zip,.md,.txt,.csv. If that list
  // and the acceptance rules drift apart, the picker offers a file that the
  // control then refuses without explanation.
  const ADVERTISED = ['jpg', 'jpeg', 'png', 'gif', 'zip', 'md', 'txt', 'csv'];

  it('accepts every extension the picker offers', () => {
    for (const ext of ADVERTISED) {
      expect(isAcceptedFile(file(`sample.${ext}`, '')), ext).toBe(true);
    }
  });

  it('offers every extension the rules accept', () => {
    expect([...ACCEPTED_EXTENSIONS].sort()).toEqual([...ADVERTISED].sort());
  });
});
