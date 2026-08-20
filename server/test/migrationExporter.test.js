import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MigrationExporter } from '../src/lib/migrationExport/exporter.js';

const TEST_PASSPHRASE = 'test-passphrase-1234567890';

function createMockSource(entities, hiddenEntities = {}) {
  return {
    async ping() { return { ok: true }; },
    async read(entity, { skip = 0, limit = 500, fields = null } = {}) {
      const records = entities[entity] || [];
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
      const records = entities[entity] || [];
      const hidden = hiddenEntities[entity] || [];
      let filtered = [...records, ...hidden];
      if (query && query.id) {
        filtered = filtered.filter(r => String(r.id) === String(query.id));
      }
      return filtered.slice(skip, skip + limit);
    },
    describe() { return { appId: 'test', secretConfigured: true }; },
  };
}

function createTestConfig() {
  return {
    appId: 'test-app',
    secret: 'test-secret',
    baseUrl: 'https://test.base44.app',
    functionUrl: 'https://test.base44.app/api/apps/test-app/functions/migrateSource',
  };
}

describe('MigrationExporter', () => {
  let exporter;

  describe('duplicate source ID detection', () => {
    it('detects identical duplicate records and reports as warning', async () => {
      const entities = {
        MetaSyncRun: [
          { id: 'dup-1', data: 'same', created_date: '2026-01-01T00:00:00Z' },
          { id: 'dup-1', data: 'same', created_date: '2026-01-01T00:00:00Z' },
          { id: 'unique-1', data: 'different', created_date: '2026-01-01T00:00:00Z' },
        ],
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();

      const dups = exporter.duplicateIds.get('MetaSyncRun');
      expect(dups).toHaveLength(1);
      expect(dups[0].id).toBe('dup-1');
      expect(dups[0].isIdentical).toBe(true);
    });

    it('detects conflicting records with same ID and reports as hard blocker', async () => {
      const entities = {
        MetaSyncRun: [
          { id: 'conflict-1', data: 'first', created_date: '2026-01-01T00:00:00Z' },
          { id: 'conflict-1', data: 'second', created_date: '2026-01-02T00:00:00Z' },
        ],
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();

      const dups = exporter.duplicateIds.get('MetaSyncRun');
      expect(dups).toHaveLength(1);
      expect(dups[0].id).toBe('conflict-1');
      expect(dups[0].isIdentical).toBe(false);

      const diagnostic = exporter.buildDiagnosticReport();
      expect(diagnostic.final_status).toBe('FAIL');
      expect(diagnostic.hard_blocker_count).toBeGreaterThan(0);
      const blocker = diagnostic.hard_blockers.find(b => b.kind === 'duplicate_source_id');
      expect(blocker).toBeDefined();
      expect(blocker.entity).toBe('MetaSyncRun');
      expect(blocker.source_id).toBe('conflict-1');
    });

    it('emits identical duplicates exactly once in package', async () => {
      const entities = {
        MetaSyncRun: [
          { id: 'dup-1', data: 'same', created_date: '2026-01-01T00:00:00Z' },
          { id: 'dup-1', data: 'same', created_date: '2026-01-01T00:00:00Z' },
        ],
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();

      await exporter.createEncryptedPackage();

      const pkg = JSON.parse(fs.readFileSync('/tmp/test-package.json', 'utf8'));
      const metasyncChunks = pkg.chunks.filter(c => c.entity === 'MetaSyncRun');
      expect(metasyncChunks.length).toBeGreaterThan(0);

      let totalRecords = 0;
      for (const chunk of metasyncChunks) {
        const key = crypto.pbkdf2Sync(
          Buffer.from(TEST_PASSPHRASE, 'utf8'),
          Buffer.from(pkg.crypto.salt, 'base64'),
          pkg.crypto.iterations,
          pkg.crypto.key_bits / 8,
          'sha256'
        );
        const iv = Buffer.from(chunk.iv, 'base64');
        const ciphertext = Buffer.from(chunk.ciphertext, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(ciphertext.slice(-16));
        const plaintext = Buffer.concat([decipher.update(ciphertext.slice(0, -16)), decipher.final()]);
        const payload = JSON.parse(plaintext.toString('utf8'));
        totalRecords += payload.records.length;
      }
      expect(totalRecords).toBe(1);
    });
  });

  describe('referential integrity validation', () => {
    it('validates required child relationship whose parent exists', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
        BuyerStateCpl: [{ id: 'cpl-1', buyer_id: 'buyer-1', state: 'CA', cpl: 100 }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      await exporter.validateRelationships();

      expect(exporter.unrecoverableReferences).toHaveLength(0);
      expect(exporter.optionalDanglingReferences).toHaveLength(0);
    });

    it('recovers required referenced parent omitted by normal filter', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
        BuyerStateCpl: [
          { id: 'cpl-1', buyer_id: 'buyer-1', state: 'CA', cpl: 100 },
          { id: 'cpl-2', buyer_id: 'buyer-2', state: 'NY', cpl: 200 },
        ],
      };
      const hiddenEntities = {
        Buyer: [{ id: 'buyer-2', buyer_code: 'B2' }],
      };

      const mockSource = createMockSource(entities, hiddenEntities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      await exporter.validateRelationships();

      expect(exporter.recoveredParents.length).toBeGreaterThan(0);
      const recovered = exporter.recoveredParents.find(r => r.id === 'buyer-2');
      expect(recovered).toBeDefined();
      expect(recovered.referencedBy).toBe('BuyerStateCpl.buyer_id');

      expect(exporter.unrecoverableReferences).toHaveLength(0);
    });

    it('fails preflight for truly missing required parent', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
        BuyerStateCpl: [{ id: 'cpl-1', buyer_id: 'missing-buyer', state: 'CA', cpl: 100 }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      await exporter.validateRelationships();

      expect(exporter.unrecoverableReferences.length).toBeGreaterThan(0);
      const missing = exporter.unrecoverableReferences.find(r => r.referencedId === 'missing-buyer');
      expect(missing).toBeDefined();
      expect(missing.required).toBe(true);

      const diagnostic = exporter.buildDiagnosticReport();
      expect(diagnostic.final_status).toBe('FAIL');
      expect(diagnostic.hard_blocker_count).toBeGreaterThan(0);
    });

    it('reports optional dangling relationship as warning only', async () => {
      const entities = {
        Lead: [{ id: 'lead-1', supplier_key_id: 'missing-key' }],
        ApiKey: [{ id: 'key-1', supplier_id: 'supplier-1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      await exporter.validateRelationships();

      expect(exporter.optionalDanglingReferences.length).toBeGreaterThan(0);
      const dangling = exporter.optionalDanglingReferences.find(r => r.referencedId === 'missing-key');
      expect(dangling).toBeDefined();
      expect(dangling.required).toBe(false);

      const diagnostic = exporter.buildDiagnosticReport();
      expect(diagnostic.final_status).toBe('PASS');
    });
  });

  describe('manifest and count reconciliation', () => {
    it('validates manifest totals match emitted records', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1' }, { id: 'buyer-2' }],
        Campaign: [{ id: 'campaign-1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.checkManifest();

      expect(exporter.counts.get('Buyer')).toBe(2);
      expect(exporter.counts.get('Campaign')).toBe(1);
    });

    it('detects manifest count mismatch as hard blocker', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.counts.set('Buyer', 5);
      exporter.checkManifest();

      const diagnostic = exporter.buildDiagnosticReport();
      expect(diagnostic.final_status).toBe('FAIL');
      const blocker = diagnostic.hard_blockers.find(b => b.detail.includes('manifest count'));
      expect(blocker).toBeDefined();
    });
  });

  describe('pagination consistency', () => {
    it('tracks pagination info for each entity', async () => {
      const entities = {
        Buyer: Array.from({ length: 1200 }, (_, i) => ({ id: `buyer-${i}`, buyer_code: `B${i}` })),
        Campaign: [{ id: 'campaign-1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();

      const buyerPages = exporter.paginationInfo.filter(p => p.entity === 'Buyer');
      expect(buyerPages.length).toBe(3);
      expect(buyerPages[0].returned).toBe(500);
      expect(buyerPages[1].returned).toBe(500);
      expect(buyerPages[2].returned).toBe(200);
    });
  });

  describe('credential protection in diagnostics', () => {
    it('never includes credential values in diagnostic output', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1', buyer_api_key: 'secret-key-value' }],
        ApiKey: [{ id: 'key-1', supplier_id: 'supplier-1', key: 'secret-api-key' }],
        BuyerStateCpl: [{ id: 'cpl-1', buyer_id: 'buyer-1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      await exporter.validateRelationships();
      const diagnostic = exporter.buildDiagnosticReport();

      const diagnosticStr = JSON.stringify(diagnostic);
      expect(diagnosticStr).not.toContain('secret-key-value');
      expect(diagnosticStr).not.toContain('secret-api-key');
    });
  });

  describe('encrypted package integrity', () => {
    it('creates valid encrypted package with correct structure', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1', buyer_api_key: 'test-key' }],
        Supplier: [{ id: 'supplier-1', name: 'Test Supplier', sid: 'TS1' }],
        Campaign: [{ id: 'campaign-1', name: 'Test Campaign', campaign_id: 'TC1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();
      await exporter.validateRelationships();
      exporter.checkManifest();
      await exporter.createEncryptedPackage();

      const pkg = JSON.parse(fs.readFileSync('/tmp/test-package.json', 'utf8'));
      expect(pkg.format).toBe('legenex-migration-v1');
      expect(pkg.source_app).toBe('legenex-dashboard');
      expect(pkg.target).toBe('dashflo');
      expect(pkg.crypto).toBeDefined();
      expect(pkg.crypto.iterations).toBe(600000);
      expect(pkg.crypto.salt).toBeDefined();
      expect(pkg.chunks).toBeInstanceOf(Array);
      expect(pkg.chunks.length).toBeGreaterThan(0);
      expect(pkg.counts).toBeDefined();
      expect(pkg.counts.Buyer).toBe(1);
      expect(pkg.counts.Supplier).toBe(1);
      expect(pkg.counts.Campaign).toBe(1);

      for (const chunk of pkg.chunks) {
        expect(chunk.entity).toBeDefined();
        expect(typeof chunk.offset).toBe('number');
        expect(typeof chunk.records).toBe('number');
        expect(chunk.iv).toBeDefined();
        expect(chunk.ciphertext).toBeDefined();
        expect(chunk.plaintext_sha256).toBeDefined();
      }
    });

    it('package can be decrypted and verified', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1', buyer_api_key: 'test-key' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        outputPath: '/tmp/test-package.json',
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();
      await exporter.validateRelationships();
      exporter.checkManifest();
      await exporter.createEncryptedPackage();

      const pkg = JSON.parse(fs.readFileSync('/tmp/test-package.json', 'utf8'));
      const key = crypto.pbkdf2Sync(
        Buffer.from(TEST_PASSPHRASE, 'utf8'),
        Buffer.from(pkg.crypto.salt, 'base64'),
        pkg.crypto.iterations,
        pkg.crypto.key_bits / 8,
        'sha256'
      );

      let totalRecords = 0;
      for (const chunk of pkg.chunks) {
        const iv = Buffer.from(chunk.iv, 'base64');
        const ciphertext = Buffer.from(chunk.ciphertext, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(ciphertext.slice(-16));
        const plaintext = Buffer.concat([decipher.update(ciphertext.slice(0, -16)), decipher.final()]);
        const payload = JSON.parse(plaintext.toString('utf8'));

        expect(payload.entity).toBe(chunk.entity);
        expect(payload.offset).toBe(chunk.offset);
        expect(payload.records.length).toBe(chunk.records);

        const sha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
        expect(sha256).toBe(chunk.plaintext_sha256);

        totalRecords += payload.records.length;
      }
      expect(totalRecords).toBe(1);
    });
  });

  describe('preflight-only mode', () => {
    it('stops before encryption when preflight-only and passes', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
        BuyerStateCpl: [{ id: 'cpl-1', buyer_id: 'buyer-1' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        output: '/tmp/test-package.json',
        preflightOnly: true,
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();
      await exporter.validateRelationships();
      exporter.checkManifest();

      const diagnostic = exporter.buildDiagnosticReport();
      expect(diagnostic.final_status).toBe('PASS');
    });

    it('reports failure when preflight-only and hard blockers exist', async () => {
      const entities = {
        Buyer: [{ id: 'buyer-1', buyer_code: 'B1' }],
        BuyerStateCpl: [{ id: 'cpl-1', buyer_id: 'missing-buyer' }],
      };

      const mockSource = createMockSource(entities);
      exporter = new MigrationExporter({
        config: createTestConfig(),
        passphrase: TEST_PASSPHRASE,
        output: '/tmp/test-package.json',
        preflightOnly: true,
        logger: { log: () => {} },
      });
      exporter.source = mockSource;

      await exporter.collectEntities();
      exporter.validateRecordIds();
      await exporter.validateRelationships();
      exporter.checkManifest();

      const diagnostic = exporter.buildDiagnosticReport();
      expect(diagnostic.final_status).toBe('FAIL');
      expect(diagnostic.hard_blocker_count).toBeGreaterThan(0);
    });
  });
});