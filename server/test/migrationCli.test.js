import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { generateTimestampedFilename, createReadlineInterface, question } from '../../scripts/migrationCliUtils.js';
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
      const inputPromise = Promise.resolve('test-input');
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