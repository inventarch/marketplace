# Product Base Vocabulary Reference (`product-base-system` `0.1.0`)

`inventarch/ia-product-base-kit` provides the public `@prd` definition word, consented cross-system relationships, and the offline `check-prds` verifier so product and engineering repositories can author, ratify, and trace Product Requirement Documents 100% offline.

## `@prd` (`lowers to definition`)

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `meaning.says` | `text` | yes | Concise summary of what the PRD defines. |
| `meaning.answers` | `text` | no | Product question this document settles. |
| `meaning.title` | `text` | no | Human-readable document title. |
| `meaning.problem` | `text` | yes | User or business problem statement (must be non-empty). |
| `scope.goals` | `list of text` | yes | Measurable outcomes in scope (non-empty when `ratified` or `active`). |
| `scope.non-goals` | `list of text` | yes | Explicit exclusions and boundaries. |
| `scope.requirements` | `list of text` | yes | Requirement clauses, e.g. `"REQ-01: ..."` (non-empty and unique clause prefixes when `ratified` or `active`). |
| `governance.status` | `id in [draft, in-review, ratified, active, superseded, withdrawn]` | yes | Lifecycle standing of the PRD. |
| `governance.owner` | `text` | no | Accountable product owner or team. |
| `governance.source` | `text` | no | Credential-free repo-relative path or external document URL. |
| `governance.body-digest` | `text` | no | 64-character lowercase hex SHA-256 pinning a split or external body. |

## Consented Relationships

- **Citations (`cite`):** two-way `cite * using prd` and `cite prd using *`, connecting `@prd` with `@spec`, `@decision`, `@plan`, `@milestone`, `@task`, `@docket`, and `@approval`.
- **Grounding (`ground`):** `ground spec, plan, milestone, task using prd`, letting a `@prd` ground derived `@spec`, `@plan`, `@milestone`, and `@task` records.
- **Dependencies (`require`):** `require decision, milestone, task using prd`.
- **Supersession (`supersede`):** `supersede prd using prd` (cardinality at most one target per `@schema prd`).
- **Governance (`govern`):** `govern prd using law, convention`.

## Offline Checker (`check-prds`)

`scripts/check-prds.mjs` inspects admitted workspace records and enforces:

- `PRD_PROBLEM_EMPTY`, `PRD_BLANK_ENTRY`: refuses blank `meaning.problem` or blank items inside `scope.goals`, `scope.non-goals`, or `scope.requirements`.
- `PRD_GOALS_EMPTY`, `PRD_REQUIREMENTS_EMPTY`, `PRD_REQUIREMENT_DUPLICATE_ID`: requires `ratified` and `active` PRDs to carry at least one goal, at least one requirement clause, and unique `<CLAUSE-ID>:` prefixes.
- `PRD_UNTRACED_COVERAGE`, `PRD_TRACE_WITHDRAWN`: requires every `ratified` or `active` PRD to link (via outgoing `cite`/`ground`/`require` or incoming `cite`/`ground`) to at least one admitted, non-withdrawn `@spec` or `@decision` record.
- `PRD_SOURCE_INVALID`, `PRD_BODY_DIGEST_FORMAT`, `PRD_DIGEST_WITHOUT_SOURCE`: enforces credential-free, traversal-free `governance.source` locators and 64-hex SHA-256 `governance.body-digest` values paired with a `governance.source`.
- `PRD_SUPERSEDE_CYCLE`: refuses cycles in `@prd` `supersede` chains.
- `PRD_UNSEALED`: when an `@approval-rule` in the workspace covers `prd`, requires every `ratified` or `active` `@prd` to carry a matching `@approval` seal.
- `APPROVAL_FILE_MISNAMED`: refuses an `@approval` saved under a file name other than `<record>.<digest prefix>.<key tag>.ia`, as `check-seal` does (`seal-malformed`); such an approval counts for nothing.
