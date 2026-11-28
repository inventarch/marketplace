# IA Approval Base Kit (`inventarch/ia-approval-kit`)

Public `Apache-2.0` base kit for cryptographic record ratification in IA workspaces. It declares `approval-system` (`0.1.0`), its uniform steward (`@agent approval-system-steward`) and stewardship mandate (`@mandate approval-system-stewardship`), four canonical record schemas and authoring guides, governance conventions and laws, and the zero-dependency offline `check-seal` verifier.

## Minted Vocabulary

- `@approver` — ratifying directory account, workspace scope, optional delayed recovery/Slack notices, and Ed25519 public keys.
- `@approval-rule` — selector (`words`, `kinds`, `paths`, `pieces unrecognised`), distinct-approver `quorum`, `via`, `key-kind`, `staleness`, and `merge` mode.
- `@docket` — intake or producing run piece-recognition manifest (`matched`, `none`, `ambiguous`) with planted-pattern and `desk` guards.
- `@approval` — single-signer Ed25519 seal over the RFC 8785 JCS `SealStatement` binding `recordDigest`, one-hop `dependsOn` digests, answered `rules`, and corpus `revision`.

See [assets/approval-vocabulary.md](assets/approval-vocabulary.md) for the full `SealStatement` specification, key-id derivation, staleness semantics, and CLI modes.

## Compatibility Rule

Only one composed system in a workspace may mint `approver`, `approval-rule`, `docket`, or `approval`. Workspaces that adopt `inventarch/ia-approval-kit` restore and validate 100% offline with `@inventarch/cli@3.10.0` and `inventarch/language` (`^3.0.0`, locked at `3.2.0`).

## Declared Checks (`checks.json`)

- `approval-check-validate`: runs `ia validate --json` in the workspace through the resolved CLI.
- `check-seal`: runs `scripts/check-seal.mjs` offline using Node built-in `node:crypto` Ed25519 + RFC 8785 JCS canonicalization.

## License

Apache-2.0.
