# Learnings

Reusable lessons that should make later units cheaper. Append only.

---

## Do not plan this project from prose descriptions of it
The v1 handoff described a system in trouble. The repository showed 1,491 passing tests, a root gate, continuous deployment, engine parity enforcement and restore-verified backups. A plan written from the description deferred capabilities that already worked, including ZIP and county filters and weekly and monthly caps. Read the code first, every time.

## A GitHub 403 is usually a rate limit, not a permission problem
`API rate limit exceeded for <ip>` on a shared address looks identical to a private repository at first glance. Clone before concluding the repository is inaccessible.

## Status vocabularies leak into places you will not grep for
`ApiConnector`, `LeadByteConnector` and `InboundWebhookRoute` all derive trigger keys from the lead status field. A trigger that matches nothing throws no error, so a status rename fails silently rather than loudly. Search for the vocabulary, not just the field name.

## A gate run with skipped suites is not a green gate
181 of this repository's tests skip themselves when no database is reachable, and they are the ones that prove durable receipt, intake and migration invariants. Skipped is not passed.
