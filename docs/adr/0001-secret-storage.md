# ADR 0001: Secret storage for supplier keys and destination credentials

Status: Accepted

Date: 15 August 2026

Task: S4

Commit introducing the implementation: `84a5798`

## Context

Two kinds of secret pass through DashFlo and they have opposite requirements.

A supplier API key is presented by the supplier on every lead post. The server
only ever needs to answer one question about it: does this presented value
identify a known supplier. It never needs to reproduce the value.

A buyer destination credential is the opposite. The server has to present it to
a third party on delivery, so it must be recoverable at the moment of use. A
one way hash is useless for it.

Before S4 both were stored the same way, in cleartext columns readable through
the generic entity route. Invariant 4 forbids storing raw API keys or secrets
where they can reach payloads, logs, exports, fixtures or commits, and invariant
10 requires supplier keys to be hash only at rest with reversible destination
credentials held behind an opaque reference.

## Decision

Treat the two cases differently, because they are different.

### Supplier API keys are hash only

`ApiKey` carries `key_hash`, a SHA-256 of the presented value. Resolution is by
hash lookup. The server never needs the original, so it does not keep one.

SHA-256 without a work factor is the right choice here and a poor one for
passwords. The difference is entropy. These keys are minted by
`mintApiKey` from `crypto.randomBytes`, so the search space is the full key
space rather than a human-chosen phrase, and a slow hash would buy nothing
while adding latency to the hot path of every lead post. The requirement that
the check stays well inside the five second supplier response contract is real.

The previous generator used `Math.random()`, which is not a cryptographic
source. That is corrected in the same change.

The cleartext `key` column is retained for now and is not part of the resolution
path once a row is backfilled. Removing it is a separate task with explicit
preconditions, recorded under "S4 cleartext purge" in `STATE.md`. Purging is
irreversible, because the raw values cannot be recovered from the hashes, so a
premature purge means rotating every supplier key.

### Destination credentials are server side, behind an opaque reference

`IntegrationConfig.config` is written only through `saveIntegrationConfig`,
which merges a partial update over the stored blob on the server, and read only
through `integrationConfigStatus`, which returns settings by value and secrets
as presence alone. No client receives a credential value.

Both `key` and `config` are write denied on the generic entity route, on create
as well as update, so the policy cannot be bypassed by addressing the entity
directly.

### The generic route is not a credential surface

`key`, `key_hash` and `config` are dropped before reaching the database when
they arrive through the generic entity route. This is enforced in
`lib/entityPolicy.js` rather than in each function, so a new function does not
have to remember it.

## Consequences

Accepted:

- A supplier key that is lost cannot be recovered and must be rotated. This is
  the intended property, not a defect.
- Supplier posting spec links derive their token from the key hash once
  cleartext is gone, so every link already issued to a supplier has to be
  reissued before the purge. This is precondition 4 in `STATE.md`.
- `client/src/components/suppliers/PostingSpecs.jsx` builds its link from a
  value the browser can no longer see, so that page has been wrong since S1
  read denied it. It needs a small server function returning the token for an
  authorized operator. Not fixed in S4, to keep the change bounded.

Known open risk:

- Two concurrent writers to one `IntegrationConfig` row can still interleave.
  `Repo.update` has no optimistic locking and `config` is a single opaque
  string, so a service function's read modify write and an operator's save can
  overwrite each other. The window is much smaller than before, because the
  merge now happens server side against fresh data, but it is not closed.
  `UNPROVEN`: no test exercises that race.

## Rotation list

Credential references only. No value appears in this repository and none should
be pasted into it. Full detail is in the Gate B section of `STATE.md`.

| Reference | Why it must be rotated or set |
|---|---|
| `MIGRATE_SOURCE_SECRET` | The previous value was committed to `server/src/functions/migrateSource.js` and remains in git history. The endpoint streams every entity in the database. Treat the old value as compromised. |
| `JWT_SECRET` | Production previously fell back to a known development value. Startup now refuses that fallback, and a real value is required at deploy time. |
| `DNC_HASH_KEY` | New in I2. Every do-not-contact entry is hashed under it. It has no default and the DNC surface fails closed without it. Rotating it later invalidates every stored suppression, and the raw contacts are deliberately not kept, so a rotation means rebuilding the list from its original sources. Decide the key management approach before the list is populated. |

## Alternatives considered

Encrypting supplier keys at rest with a recoverable cipher was rejected. It
keeps a decryption path that nothing needs, so it enlarges the blast radius of a
key compromise for no operational benefit.

Storing destination credentials in an external secret manager was not rejected
on the merits and remains the better long term answer. It is out of scope for
the cutover because it adds a deployment dependency that Gate C does not yet
cover. The opaque reference model is deliberately compatible with moving to one
later: callers already ask a server side service for a credential rather than
reading a column.

## Verification

`server/test/apiKeyHashing.test.js` and `server/test/integrationCredentials.test.js`,
42 tests, plus 3 in `server/test/entityRoute.test.js` covering the route level
write deny. Observed behaviour is recorded in the S4 evidence entry in
`STATE.md`, including the switch that proves the hash path stands alone:
with `DASHFLO_APIKEY_LEGACY_CLEARTEXT=0` a cleartext only row stops resolving
while a backfilled row keeps resolving.
