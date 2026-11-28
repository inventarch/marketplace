# IA Product Base Kit (`inventarch/ia-product-base-kit`)

Public `Apache-2.0` base kit for Product Requirement Documents (`@prd`) and requirement-to-specification traceability. It declares `product-base-system` (`0.1.0`), its uniform steward (`@agent product-base-system-steward`) and stewardship mandate (`@mandate product-base-system-stewardship`), the canonical `@prd` schema and authoring guide, consented relationships to `@spec`, `@decision`, `@plan`, `@docket`, and `@approval`, ratification and decomposition rules, and the offline `check-prds` verifier.

## Minted Vocabulary

- `@prd` — Product Requirement Document record declaring `meaning.says`, optional `meaning.answers` and `meaning.title`, `meaning.problem`, `scope.goals`, `scope.non-goals`, `scope.requirements`, `governance.status` (`draft`, `in-review`, `ratified`, `active`, `superseded`, `withdrawn`), and optional `governance.owner`, `governance.source`, and `governance.body-digest`.

See [assets/product-vocabulary.md](assets/product-vocabulary.md) for the field contract, consented cross-vocabulary relationships, ratification rules, and offline checker invariants.

## Compatibility Rule

No workspace may compose another system that mints `prd`. Product and engineering workspaces stand on `inventarch/ia-product-base-kit` (and optionally `inventarch/ia-approval-kit` for cryptographic seals) to validate `@prd` records and their `@spec`/`@decision` coverage 100% offline with `@inventarch/cli@3.10.0` and `inventarch/language` (`^3.0.0`, locked at `3.2.0`), while proprietary PRD-to-spec procedures and external wiki connectors stay outside the public base kit.

## Declared Checks (`checks.json`)

- `product-check-validate`: runs `ia validate --json` in the workspace through the resolved CLI.
- `check-prds`: runs `scripts/check-prds.mjs` offline over the workspace's admitted records.

## License

Apache-2.0.
