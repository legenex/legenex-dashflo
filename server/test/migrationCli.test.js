import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { generateTimestampedFilename, createReadlineInterface, question, readHiddenPassphrase, readHiddenPassphraseWithConfirmation } from '../../scripts/migrationCliUtils.js';
import readline from 'node:readline';

describe('create-migration-package CLI', () => {
  describe('generateTimestampedFilename', () => {
    it('generates correct format with timestamp', () => {
      const filename = generateTimestampedFilename('test', 'json.enc');
      expect(filename).toMatch(/^test-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json\.enc$/);
    });

    it('generates correct format for diagnostic', () => {
      const filename = generateTimestampedFilename('test-diagnostic', 'json');
      expect(filename).toMatch(/^test-diagnostic-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    });
  });

  describe('question', () => {
    it('resolves with user input', async () => {
      const rl = createReadlineInterface();
      vi.spyOn(rl, 'question').mockImplementation((query, cb) => cb('test-input'));
      
      const result = await question(rl, 'Test: ');
      expect(result).toBe('test-input');
      rl.close();
    });
  });

  describe('createReadlineInterface', () => {
    it('creates readline interface', () => {
      const rl = createReadlineInterface();
      expect(rl).toBeDefined();
      expect(typeof rl.question).toBe('function');
      expect(typeof rl.close).toBe('function');
      rl.close();
    });
  });
});

describe('Hidden passphrase input', () => {
  let originalStdin;
  let originalStdout;
  let mockStdin;
  let mockStdout;
  let writtenOutput;

  beforeEach(() => {
    originalStdin = process.stdin;
    originalStdout = process.stdout;
    
    writtenOutput = '';
    mockStdout = {
      write: vi.fn((str) => { writtenOutput += str; return true; }),
      isTTY: true,
    };
    mockStdin = {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: mockStdout, configurable: true });
    Object.defineProperty(process, 'removeListener', { value: vi.fn(), configurable: true });
    Object.defineProperty(process, 'on', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
    vi.restoreAllMocks();
  });

  it('rejects when not a TTY', async () => {
    mockStdin.isTTY = false;
    await expect(readHiddenPassphrase('Pass: ')).rejects.toThrow('Not a TTY');
  });

  it('writes prompt to stdout', async () => {
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        // Simulate typing "secret" + Enter
        setImmediate(() => handler(Buffer.from('secret\n')));
      }
    });
    
    const promise = readHiddenPassphrase('Migration passphrase: ');
    // Give it a moment to set up
    await new Promise(r => setImmediate(r));
    
    expect(mockStdout.write).toHaveBeenCalledWith('Migration passphrase: ');
  });

  it('does not echo passphrase characters to stdout', async () => {
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        // Use process.nextTick to ensure handler is registered
        process.nextTick(() => handler(Buffer.from('secret\n')));
      }
    });
    
    await readHiddenPassphrase('Pass: ');
    
    // Check that passphrase characters are not echoed
    // (only asterisks for the characters, not the actual characters)
    expect(writtenOutput).not.toContain('secret');
    // Should have written asterisks for each character
    const asteriskCount = (writtenOutput.match(/\*/g) || []).length;
    expect(asteriskCount).toBe(6);
  });

  it('handles backspace correctly', async () => {
    let resolvePromise;
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => {
          // Type "ab", backspace, "c", Enter
          handler(Buffer.from('ab'));
          handler(Buffer.from('\x7f')); // DEL/backspace
          handler(Buffer.from('c\n'));
        });
      }
    });
    
    const result = await readHiddenPassphrase('Pass: ');
    expect(result).toBe('ac');
  });

  it('throws on Ctrl+C', async () => {
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => {
          handler(Buffer.from('\x03')); // Ctrl+C
        });
      }
    });
    
    await expect(readHiddenPassphrase('Pass: ')).rejects.toThrow('Cancelled');
  });

  it('restores terminal state on success', async () => {
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => handler(Buffer.from('secret\n')));
      }
    });
    
    await readHiddenPassphrase('Pass: ');
    expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
    expect(mockStdin.pause).toHaveBeenCalled();
  });

  it('restores terminal state on error', async () => {
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => handler(Buffer.from('\x03')));
      }
    });
    
    try {
      await readHiddenPassphrase('Pass: ');
    } catch {}
    
    expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
    expect(mockStdin.pause).toHaveBeenCalled();
  });

  it('readHiddenPassphraseWithConfirmation rejects mismatched passphrases', async () => {
    let callCount = 0;
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => {
          if (callCount === 0) handler(Buffer.from('pass1\n'));
          else if (callCount === 1) handler(Buffer.from('pass2\n'));
          else if (callCount === 2) handler(Buffer.from('pass1\n'));
          else if (callCount === 3) handler(Buffer.from('pass1\n'));
          callCount++;
        });
      }
    });
    
    await expect(readHiddenPassphraseWithConfirmation('Pass: ', 'Confirm: ', 4)).rejects.toThrow('Passphrases do not match');
  });

  it('readHiddenPassphraseWithConfirmation accepts matching passphrases', async () => {
    let callCount = 0;
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => {
          if (callCount === 0) handler(Buffer.from('secret123\n'));
          else if (callCount === 1) handler(Buffer.from('secret123\n'));
          callCount++;
        });
      }
    });
    
    const result = await readHiddenPassphraseWithConfirmation('Pass: ', 'Confirm: ', 4);
    expect(result).toBe('secret123');
  });

  it('readHiddenPassphraseWithConfirmation enforces minimum length', async () => {
    mockStdin.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        setImmediate(() => {
          handler(Buffer.from('short\n'));
        });
      }
    });
    
    await expect(readHiddenPassphraseWithConfirmation('Pass: ', 'Confirm: ', 10)).rejects.toThrow('at least 10 characters');
  });
});

describe('MigrationExporter passphrase security', () => {
  let mockSource;
  let exporter;
  let testConfig;

  beforeEach(() => {
    testConfig = {
      appId: 'test-app',
      secret: 'test-secret',
      baseUrl: 'https://test.base44.app',
      functionUrl: 'https://test.base44.app/api/apps/test-app/functions/migrateSource',
    };

    mockSource = {
      async ping() { return { ok: true }; },
      async read(entity, { skip = 0, limit = 500, fields = null } = {}) {
        const records = { Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }] }[entity] || [];
        let page = records.slice(skip, skip + limit);
        if (fields) {
          page = page.map(r => {
            const out = {};
            for (const f of fields) if (Object.prototype.hasOwnProperty.call(r, f)) out[f] = r[f];
            return out;
          });
        }
        return page;
      },
      async filter(entity, query, { skip = 0, limit = 500 } = {}) {
        const records = { Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }] }[entity] || [];
        let filtered = records;
        if (query && query.id) {
          filtered = records.filter(r => String(r.id) === String(query.id));
        }
        return filtered.slice(skip, skip + limit);
      },
      describe() { return { appId: 'test', secretConfigured: true }; },
    };
  });

  it('clears passphrase after encryption', async () => {
    const { MigrationExporter } = await import('../src/lib/migrationExport/exporter.js');
    
    exporter = new MigrationExporter({
      config: testConfig,
      passphrase: 'test-passphrase-1234567890',
      outputPath: '/tmp/test-package.json',
      logger: { log: () => {} },
    });
    exporter.source = mockSource;

    await exporter.collectEntities();
    exporter.validateRecordIds();
    await exporter.validateRelationships();
    exporter.checkManifest();
    await exporter.createEncryptedPackage();

    // Passphrase should be cleared after encryption
    expect(exporter.passphrase).toBeNull();
  });

  it('does not include passphrase in diagnostic report', async () => {
    const { MigrationExporter } = await import('../src/lib/migrationExport/exporter.js');
    
    exporter = new MigrationExporter({
      config: testConfig,
      passphrase: 'test-passphrase-1234567890',
      outputPath: '/tmp/test-package.json',
      diagnosticPath: '/tmp/diagnostic.json',
      logger: { log: () => {} },
    });
    exporter.source = mockSource;

    await exporter.collectEntities();
    exporter.validateRecordIds();
    await exporter.validateRelationships();
    exporter.checkManifest();
    
    const diagnostic = exporter.buildDiagnosticReport();
    const diagnosticStr = JSON.stringify(diagnostic);
    
    expect(diagnosticStr).not.toContain('test-passphrase-1234567890');
    expect(diagnosticStr).not.toContain('passphrase');
  });

  it('does not log passphrase', async () => {
    const { MigrationExporter } = await import('../src/lib/migrationExport/exporter.js');
    const logs = [];
    
    exporter = new MigrationExporter({
      config: testConfig,
      passphrase: 'test-passphrase-1234567890',
      outputPath: '/tmp/test-package.json',
      logger: { log: (msg) => logs.push(msg) },
    });
    exporter.source = mockSource;

    await exporter.collectEntities();
    exporter.validateRecordIds();
    await exporter.validateRelationships();
    exporter.checkManifest();
    await exporter.createEncryptedPackage();

    const allLogs = logs.join(' ');
    expect(allLogs).not.toContain('test-passphrase-1234567890');
    expect(allLogs).not.toContain('passphrase');
  });
});