import crypto from 'node:crypto';
import { Base44Source, base44ConfigFromEnv } from '../base44Source.js';
import {
  MIGRATION_CRYPTO,
  MIGRATION_FORMAT,
  MIGRATION_ENTITY_ORDER,
  MIGRATION_ONLY_ENTITIES,
  MIGRATION_DROP_RECORD,
  REFS,
  NATURAL_KEYS,
} from '../../functions/systemTransfer.generated.js';
import { requiredFields } from '../migrationPlan.js';

const MAX_PAGE = 500;
const CHUNK_RECORD_LIMIT = 5000;

const SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

export class MigrationExporter {
  constructor({ config, passphrase, outputPath, diagnosticPath, preflightOnly, logger = console } = {}) {
    this.config = config;
    this.passphrase = passphrase;
    this.outputPath = outputPath;
    this.diagnosticPath = diagnosticPath;
    this.preflightOnly = preflightOnly;
    this.logger = logger;
    this.source = new Base44Source(config);
    this.entities = new Map();
    this.counts = new Map();
    this.duplicateIds = new Map();
    this.missingReferences = [];
    this.optionalDanglingReferences = [];
    this.recoveredParents = [];
    this.unrecoverableReferences = [];
    this.paginationInfo = [];
    this.startTime = Date.now();
  }

  async run() {
    this.log('Starting migration package export');
    this.log(`Configuration: ${JSON.stringify(this.source.describe())}`);

    await this.source.ping();
    this.log('Base44 source ping successful');

    await this.collectEntities();
    this.validateRecordIds();
    await this.validateRelationships();
    this.checkManifest();

    const diagnostic = this.buildDiagnosticReport();

    if (this.diagnosticPath) {
      const fs = await import('node:fs');
      fs.writeFileSync(this.diagnosticPath, JSON.stringify(diagnostic, null, 2));
      this.log(`Diagnostic report written to ${this.diagnosticPath}`);
    }

    if (diagnostic.hard_blocker_count > 0) {
      this.log('PREFLIGHT FAILED: Hard integrity errors found', SEVERITY.ERROR);
      for (const blocker of diagnostic.hard_blockers) {
        this.log(`  [BLOCKER] ${blocker.entity}.${blocker.field || 'id'}: ${blocker.detail}`, SEVERITY.ERROR);
      }
      if (this.preflightOnly) {
        this.log('Preflight-only mode: stopping before encryption');
        throw new Error('PREFLIGHT_FAILED');
      }
      throw new Error('Export preflight failed: ' + diagnostic.hard_blockers.map(b => b.detail).join('; '));
    }

    if (this.preflightOnly) {
      this.log('Preflight-only mode: all checks passed, stopping before encryption');
      return;
    }

    this.log('Preflight passed, creating encrypted package');
    await this.createEncryptedPackage();
    this.log(`Migration package written to ${this.outputPath}`);
  }

  async collectEntities() {
    this.log('Collecting entities...');

    for (const entity of MIGRATION_ENTITY_ORDER) {
      if (entity === 'User' || entity === 'Invitation') {
        this.log(`Skipping ${entity} (authentication not portable)`);
        continue;
      }

      this.log(`  Collecting ${entity}...`);
      const records = [];
      let offset = 0;
      let pageCount = 0;

      while (true) {
        const page = await this.source.read(entity, { skip: offset, limit: MAX_PAGE });
        pageCount++;
        this.paginationInfo.push({ entity, page: pageCount, offset, returned: page.length });

        if (!page.length) break;
        records.push(...page);

        if (page.length < MAX_PAGE) break;
        offset += page.length;
      }

      if (MIGRATION_DROP_RECORD[entity]) {
        const before = records.length;
        const filtered = records.filter(r => !MIGRATION_DROP_RECORD[entity](r));
        if (filtered.length !== before) {
          this.log(`  ${entity}: dropped ${before - filtered.length} records by exclusion rule`);
        }
        this.entities.set(entity, filtered);
        this.counts.set(entity, filtered.length);
      } else {
        this.entities.set(entity, records);
        this.counts.set(entity, records.length);
      }

      this.log(`  ${entity}: ${this.counts.get(entity)} records (${pageCount} pages)`);
    }

    const totalRecords = Array.from(this.counts.values()).reduce((a, b) => a + b, 0);
    this.log(`Total: ${totalRecords} records across ${this.entities.size} entities`);
  }

  validateRecordIds() {
    this.log('Validating record IDs...');

    for (const [entity, records] of this.entities) {
      const seen = new Map();
      const duplicates = [];
      const deduplicated = [];

      for (const record of records) {
        const id = String(record?.id || '').trim();
        if (!id) {
          this.reportHardBlocker(entity, 'id', null, 'record is missing its source id');
          continue;
        }

        if (seen.has(id)) {
          const existing = seen.get(id);
          const isIdentical = this.recordsAreIdentical(existing.record, record);
          duplicates.push({
            id,
            firstIndex: existing.index,
            duplicateIndex: records.indexOf(record),
            isIdentical,
          });
          if (!isIdentical) {
            deduplicated.push(record);
          }
        } else {
          seen.set(id, { index: deduplicated.length, record });
          deduplicated.push(record);
        }
      }

      if (duplicates.length > 0) {
        this.duplicateIds.set(entity, duplicates);
        for (const dup of duplicates) {
          if (dup.isIdentical) {
            this.log(`  [DUPLICATE] ${entity}:${dup.id} - identical records at indices ${dup.firstIndex} and ${dup.duplicateIndex}`, SEVERITY.WARNING);
          } else {
            this.reportHardBlocker(entity, 'id', dup.id, 'conflicting records with same source id');
          }
        }
        this.entities.set(entity, deduplicated);
        this.counts.set(entity, deduplicated.length);
      }
    }

    if (this.duplicateIds.size > 0) {
      const totalDups = Array.from(this.duplicateIds.values()).reduce((a, b) => a + b.length, 0);
      this.log(`Found ${totalDups} duplicate source IDs across ${this.duplicateIds.size} entities`, SEVERITY.WARNING);
    }
  }

  recordsAreIdentical(a, b) {
    const stableStringify = (obj) => {
      if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
      if (obj && typeof obj === 'object') {
        return '{' + Object.keys(obj).sort().map(k => '"' + k + '":' + stableStringify(obj[k])).join(',') + '}';
      }
      return JSON.stringify(obj);
    };
    return stableStringify(a) === stableStringify(b);
  }

  async validateRelationships() {
    this.log('Validating relationships...');

    const allEntityIds = new Map();
    for (const [entity, records] of this.entities) {
      const ids = new Set();
      for (const record of records) {
        const id = String(record?.id || '').trim();
        if (id) ids.add(id);
      }
      allEntityIds.set(entity, ids);
    }

    for (const [entity, records] of this.entities) {
      const refs = REFS[entity];
      if (!refs) continue;

      for (const record of records) {
        for (const [field, ref] of Object.entries(refs)) {
          if (ref.kind !== 'id' && ref.kind !== 'idsJson') continue;

          const referencedIds = this.extractReferenceIds(record[field], ref.kind);
          if (!referencedIds.length) continue;

          const isRequired = requiredFields(entity).has(field);
          const targetEntity = ref.target;
          const targetIds = allEntityIds.get(targetEntity) || new Set();

          for (const refId of referencedIds) {
            if (!targetIds.has(refId)) {
              const canRecover = await this.attemptParentRecovery(targetEntity, refId);
              if (canRecover) {
                this.recoveredParents.push({ entity: targetEntity, id: refId, referencedBy: `${entity}.${field}` });
                targetIds.add(refId);
                allEntityIds.set(targetEntity, targetIds);
              } else {
                const issue = {
                  entity,
                  field,
                  referencedEntity: targetEntity,
                  referencedId: refId,
                  sourceRecordId: String(record?.id || ''),
                  severity: isRequired ? SEVERITY.ERROR : SEVERITY.WARNING,
                  required: isRequired,
                };

                if (isRequired) {
                  this.unrecoverableReferences.push(issue);
                  this.reportHardBlocker(entity, field, refId, `required reference to missing ${targetEntity} record`);
                } else {
                  this.optionalDanglingReferences.push(issue);
                  this.log(`  [DANGLING OPTIONAL] ${entity}.${field} -> ${targetEntity}:${refId} (from ${entity}:${record?.id})`, SEVERITY.WARNING);
                }
              }
            }
          }
        }
      }
    }

    this.log(`Required dangling references: ${this.unrecoverableReferences.length}`);
    this.log(`Optional dangling references: ${this.optionalDanglingReferences.length}`);
    this.log(`Recovered parent records: ${this.recoveredParents.length}`);
  }

  extractReferenceIds(value, kind) {
    if (value == null || value === '') return [];
    if (kind === 'id') return [String(value)];
    if (kind === 'idsJson') {
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  async attemptParentRecovery(targetEntity, targetId) {
    if (targetEntity === 'Buyer') {
      try {
        const allRecords = await this.source.filter(targetEntity, { id: targetId }, { limit: 1 });
        if (allRecords.length > 0) {
          const parentRecord = allRecords[0];
          const existingRecords = this.entities.get(targetEntity) || [];
          const alreadyExists = existingRecords.some(r => String(r.id) === targetId);
          if (!alreadyExists) {
            this.entities.set(targetEntity, [...existingRecords, parentRecord]);
            this.counts.set(targetEntity, this.entities.get(targetEntity).length);
            return true;
          }
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  checkManifest() {
    this.log('Checking manifest consistency...');

    for (const [entity, count] of this.counts) {
      const records = this.entities.get(entity) || [];
      if (records.length !== count) {
        this.reportHardBlocker(entity, 'manifest', null, `manifest count ${count} != actual records ${records.length}`);
      }
    }
  }

  reportHardBlocker(entity, field, referencedId, detail) {
    this.missingReferences.push({
      entity,
      field,
      referencedId,
      detail,
      severity: SEVERITY.ERROR,
    });
  }

  buildDiagnosticReport() {
    const hardBlockers = [];
    for (const [entity, duplicates] of this.duplicateIds) {
      for (const dup of duplicates) {
        if (!dup.isIdentical) {
          hardBlockers.push({
            kind: 'duplicate_source_id',
            entity,
            source_id: dup.id,
            detail: 'conflicting records with same source id',
          });
        }
      }
    }

    for (const ref of this.unrecoverableReferences) {
      hardBlockers.push({
        kind: 'relationship',
        entity: ref.entity,
        field: ref.field,
        source_id: ref.sourceRecordId,
        detail: `required reference to missing ${ref.referencedEntity} record (${ref.referencedId})`,
      });
    }

    for (const ref of this.missingReferences) {
      hardBlockers.push({
        kind: ref.field === 'manifest' ? 'manifest' : 'relationship',
        entity: ref.entity,
        field: ref.field,
        source_id: ref.referencedId,
        detail: ref.detail,
      });
    }

    const relationshipIssues = [
      ...this.unrecoverableReferences.map(r => ({
        ...r,
        kind: 'relationship',
        status: 'REFERENCED_RECORD_ABSENT',
        severity: r.severity,
      })),
      ...this.optionalDanglingReferences.map(r => ({
        ...r,
        kind: 'relationship',
        status: 'REFERENCED_RECORD_ABSENT',
        severity: r.severity,
      })),
    ];

    return {
      package_timestamp: new Date().toISOString(),
      export_timestamp: new Date().toISOString(),
      entity_counts: Object.fromEntries(this.counts),
      total_record_count: Array.from(this.counts.values()).reduce((a, b) => a + b, 0),
      duplicate_source_id_findings: Array.from(this.duplicateIds.entries()).map(([entity, dups]) => ({
        entity,
        count: dups.length,
        identical: dups.filter(d => d.isIdentical).length,
        conflicting: dups.filter(d => !d.isIdentical).length,
        sample_ids: dups.slice(0, 10).map(d => d.id),
      })),
      required_dangling_references: this.unrecoverableReferences.map(r => ({
        entity: r.entity,
        field: r.field,
        referenced_entity: r.referencedEntity,
        referenced_id: r.referencedId,
        source_record_id: r.sourceRecordId,
      })),
      optional_dangling_references: this.optionalDanglingReferences.map(r => ({
        entity: r.entity,
        field: r.field,
        referenced_entity: r.referencedEntity,
        referenced_id: r.referencedId,
        source_record_id: r.sourceRecordId,
      })),
      recovered_parent_records: this.recoveredParents,
      pagination_consistency: this.paginationInfo,
      hard_blocker_count: hardBlockers.length,
      hard_blockers: hardBlockers,
      relationship_issue_count: relationshipIssues.length,
      relationship_issues: relationshipIssues,
      final_status: hardBlockers.length === 0 ? 'PASS' : 'FAIL',
    };
  }

  async createEncryptedPackage() {
    const salt = crypto.randomBytes(MIGRATION_FORMAT.salt_bytes);
    const key = crypto.pbkdf2Sync(
      Buffer.from(this.passphrase, 'utf8'),
      salt,
      MIGRATION_CRYPTO.iterations,
      MIGRATION_CRYPTO.key_bits / 8,
      'sha256'
    );

    // Clear passphrase from memory after key derivation
    this.passphrase = null;

    const chunks = [];

    for (const entity of MIGRATION_ENTITY_ORDER) {
      if (!this.entities.has(entity)) continue;
      const records = this.entities.get(entity);
      if (!records.length) continue;

      for (let offset = 0; offset < records.length; offset += CHUNK_RECORD_LIMIT) {
        const chunkRecords = records.slice(offset, offset + CHUNK_RECORD_LIMIT);
        const plaintext = Buffer.from(JSON.stringify({ entity, offset, records: chunkRecords }));
        const iv = crypto.randomBytes(MIGRATION_FORMAT.iv_bytes);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

        chunks.push({
          entity,
          offset,
          records: chunkRecords.length,
          iv: iv.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
        });
      }
    }

    const bundle = {
      format: MIGRATION_CRYPTO.format,
      source_app: 'legenex-dashboard',
      target: 'dashflo',
      exported_at: new Date().toISOString(),
      crypto: {
        format: MIGRATION_CRYPTO.format,
        kdf: MIGRATION_CRYPTO.kdf,
        iterations: MIGRATION_CRYPTO.iterations,
        cipher: MIGRATION_CRYPTO.cipher,
        key_bits: MIGRATION_CRYPTO.key_bits,
        salt_bytes: MIGRATION_CRYPTO.salt_bytes,
        iv_bytes: MIGRATION_FORMAT.iv_bytes,
        salt: salt.toString('base64'),
      },
      counts: Object.fromEntries(this.counts),
      chunks,
    };

    const fs = await import('node:fs');
    fs.writeFileSync(this.outputPath, JSON.stringify(bundle, null, 2));
  }

  log(message, level = SEVERITY.INFO) {
    const prefix = level === SEVERITY.ERROR ? '[ERROR]' : level === SEVERITY.WARNING ? '[WARN]' : '[INFO]';
    this.logger.log(`${new Date().toISOString()} ${prefix} ${message}`);
  }
}

export function createMigrationExporter(config, options = {}) {
  return new MigrationExporter({ config, ...options });
}