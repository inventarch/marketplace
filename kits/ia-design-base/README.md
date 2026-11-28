# IA Design Base Kit (`inventarch/ia-design-base-kit`)

Public `Apache-2.0` base kit for Atomic Design component hierarchies and design-pattern code lowering. It declares `design-base-system` (`0.1.0`), its uniform steward (`@agent design-base-system-steward`) and stewardship mandate (`@mandate design-base-system-stewardship`), six canonical schemas (`@design-token`, `@level`, `@part`, `@slot`, `@pattern`, `@recipe`) without colliding with floor `@template`, authoring guidance, atomic composition and semantic-token laws, and the offline `check-design-patterns` verifier.

## Minted Vocabulary

- `@design-token` — primitive, semantic, or component visual token (`token.name`, `token.tier`, `token.category`, optional `token.css-var`, `token.classes`, `token.value`, `token.modes`, and `token.standing`).
- `@level` — ranked Atomic Design stage (`level.rank`, `level.stage` in `[atom, molecule, organism, page-template, page]`, and `level.title`).
- `@part` — reusable UI component or template part (`part.name`, `part.level`, optional `part.composes`, `part.slots`, `part.tokens`, `part.variants`, `part.figma-names`, `part.code-export`, `part.because`, and `part.standing`).
- `@slot` — named composition slot owned by a `@part` (`slot.name`, `slot.part`, optional `slot.accepts` and `slot.required`).
- `@pattern` — structural arrangement of design nodes yielding a `@part` or `@level` (`pattern.name`, `pattern.yields`, `pattern.matches`, optional `pattern.slots`, `pattern.recipe`, `pattern.because`, `pattern.evidence`, and `pattern.standing`).
- `@recipe` — code-lowering specification for a `@part` (`recipe.name`, `recipe.part`, `recipe.target`, `recipe.mode` in `[use, adapt, compose, define]`, optional `recipe.template`, `recipe.props`, optional `recipe.variants`, `recipe.overrides`, `recipe.gap`, `recipe.classes`, `recipe.output`, and `recipe.standing`).

See [assets/design-vocabulary.md](assets/design-vocabulary.md) for the atomic composition rules, pattern-language grammar, recipe mode matrix, and offline checker invariants.

## Compatibility Rule

No workspace may compose another system that mints `design-token`, `level`, `part`, `slot`, `pattern`, or `recipe`. Knowledge bases and application repositories stand on `inventarch/ia-design-base-kit` (and optionally `inventarch/ia-approval-kit` for cryptographic seals) to validate atomic UI structures, patterns, and recipes 100% offline with `@inventarch/cli@3.10.0` and `inventarch/language` (`^3.0.0`, locked at `3.2.0`).

## Declared Checks (`checks.json`)

- `design-check-validate`: runs `ia validate --json` in the workspace through the resolved CLI.
- `check-design-patterns`: runs `scripts/check-design-patterns.mjs` offline over the workspace's admitted records.

## License

Apache-2.0.
