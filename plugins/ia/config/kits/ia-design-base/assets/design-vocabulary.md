# Design Base Vocabulary Reference (`design-base-system` `0.1.0`)

`inventarch/ia-design-base-kit` defines the public structural vocabulary for Atomic Design systems and deterministic pattern-to-code lowering, keeping proprietary design rubrics and live Figma tooling outside the public base.

## Atomic Hierarchy (`@design-token`, `@level`, `@part`, `@slot`)

- **Stages (`level.stage`):** `atom` -> `molecule` -> `organism` -> `page-template` -> `page` (ordered by monotonically ascending `level.rank`; `page-template` avoids colliding with floor `@template`).
- **Downward/peer composition:** a `@part` at stage $S$ may compose (`part.composes` or `require @part`) only parts at stage $\le S$ with no cycles.
- **Token tiers (`token.tier`):** `primitive` tokens define raw scales and feed `semantic` or `component` tokens via `require @design-token`; `@part` (`part.tokens`) and `@recipe` class maps reference only `semantic` or `component` tokens.
- **Slots (`@slot`):** every slot in `part.slots` declares `slot.part` pointing back to that `@part`. A part instance claims only its own frame; slot contents are planned independently.
- **Single-claimant Figma mapping:** a `@part` claims exact case-sensitive component-set names in `part.figma-names`, or `part.name` when `part.figma-names` is omitted. Two active or proposed parts claiming the same component set are reported as ambiguous (`PART_FIGMA_SET_AMBIGUOUS`), never resolved by listing order.

## `@pattern` (`lowers to definition`)

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `meaning.says` | `text` | yes | Summary of the recognised arrangement. |
| `pattern.name` | `text` | yes | Human-readable pattern name. |
| `pattern.yields` | `text` | yes | Identity (or `@part <name>` / `@level <name>`) of the yielded part or level. |
| `pattern.matches` | `list of text` | yes | Structural node entries (`frame`, `group`, `text`, `instance`, `component`, `vector`, `shape`, `slot`) with constraints, repetition (`1`, `?`, `*`, `+`), or `slot=<name>` fillers. |
| `pattern.slots` | `list of text` | no | Each `"<slot name> <- <node path>"` against declared slots of the yielded `@part`. |
| `pattern.recipe` | `text` | no | Identity of the `@recipe` lowering the yielded `@part`. |
| `pattern.evidence` | `list of text` | yes | Each `"<64-hex digest> <fileKey>#<nodeId>"` from committed frame readings. |
| `pattern.standing` | `id in [proposed, active, deprecated, retired]` | yes | Lifecycle standing; `active` requires an `@approval` seal. |
| `pattern.because` | `text` | no | Optional `@decision` identity justifying a level above its structural lower bound. |

## `@recipe` (`lowers to definition`)

| Mode | Required fields | Forbidden fields | Part `code-export` rule |
| --- | --- | --- | --- |
| `use` | `recipe.props` | `template`, `classes`, `overrides`, `gap` | Target `@part` must declare `part.code-export`. |
| `adapt` | `recipe.props`, `recipe.overrides`, `recipe.gap` | `template`, `classes` | Target `@part` must declare `part.code-export`; overrides hold semantic/component token classes only (no size, spacing, or layout classes). |
| `compose` | `recipe.template`, `recipe.props`, `recipe.classes` | `overrides`, `gap` | Composes layout from semantic/component token classes. |
| `define` | `recipe.template`, `recipe.props`, `recipe.classes`, `recipe.output` | `overrides`, `gap` | Refused (`RECIPE_DEFINE_OVER_EXPORT`) when target `@part` already has `part.code-export`. |

## Offline Checker (`check-design-patterns`)

`scripts/check-design-patterns.mjs` inspects admitted workspace records and enforces:

- `LEVEL_STAGE_RANK_ORDER`, `LEVEL_DUPLICATE_STAGE`, `PART_ATOMIC_HIERARCHY`, `PART_CYCLE`, `PART_PRIMITIVE_TOKEN`, `SLOT_OWNER_MISMATCH`, `SLOT_DUPLICATE_NAME`, `PART_FIGMA_SET_AMBIGUOUS`.
- `PATTERN_MATCHES_EMPTY`, `PATTERN_YIELDS_UNKNOWN`, `PATTERN_SLOT_UNKNOWN`, `PATTERN_RECIPE_UNKNOWN`, `PATTERN_EVIDENCE_INVALID`, `PATTERN_CYCLE`.
- `RECIPE_PART_UNKNOWN`, `RECIPE_MODE_CONTRACT`, `RECIPE_DEFINE_OVER_EXPORT`, `RECIPE_PROP_FORMAT`, `RECIPE_VARIANT_FORMAT`, `RECIPE_RAW_STYLE`, `RECIPE_ADAPT_SCALE`, `RECIPE_OUTPUT_UNSAFE`, `RECIPE_CYCLE`.
- `ACTIVE_PATTERN_UNSEALED`, `ACTIVE_RECIPE_UNSEALED`, `MISSING_NAMED_WORDS_RULE`.
- `APPROVAL_FILE_MISNAMED`: refuses an `@approval` saved under a file name other than `<record>.<digest prefix>.<key tag>.ia`, as `check-seal` does (`seal-malformed`); such an approval counts for nothing.
