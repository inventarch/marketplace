# IA Repository Structure Base Kit (`inventarch/ia-repo-kit`)

Public `Apache-2.0` base kit for describing how a Git repository is structured. It declares `repo-system` (`0.1.0`), its uniform steward (`@agent repo-system-steward`) and stewardship mandate (`@mandate repo-system-stewardship`), four canonical schemas (`@repository`, `@layer`, `@package`, `@area`), authoring guidance, a rank-independent dependency-role grammar for `package.kind`, explicit `@spec` citation consent rows, and the offline `check-layers` verifier.

## Minted Vocabulary

- `@repository` — canonical credential-free Git URL (`repository.url`), optional structural profile tie (`repository.profile`), optional organisation workspace identity (`repository.organisation`), and optional single canonical organisation knowledge-base pointer (`repository.knowledge-base`).
- `@layer` — ranked dependency tier (`layer.rank`, `layer.title`, optional `layer.paths` and `layer.policy`) with downward `require @layer` edges. Reusable layer profiles omit `layer.paths`; adopting repositories author concrete paths beside their code.
- `@package` — codebase package (`package.name`, `package.path`, `package.layer`, and optional `package.kind` in `[host, contract, core, adapter, view, composition, tool]`, where omitted means unclassified).
- `@area` — functional boundary across layers (`area.packages` and `area.purpose`) with acyclic `require @area` edges.

See [assets/repo-vocabulary.md](assets/repo-vocabulary.md) for the full dependency-role definitions, relationship consent table, and schema-vs-checker-vs-convention standing.

## Compatibility Rule

No workspace may compose another system that mints `repository`, `layer`, `package`, or `area`. Layer profiles and repository architectures stand on `inventarch/ia-repo-kit` by authoring `@layer`, `@repository`, `@package`, and `@area` records, and restore and validate 100% offline with `@inventarch/cli@3.10.0` and `inventarch/language` (`^3.0.0`, locked at `3.2.0`).

## Declared Checks (`checks.json`)

- `repo-check-validate`: runs `ia validate --json` in the workspace through the resolved CLI.
- `check-layers`: runs `scripts/layer-checker.mjs` offline over the workspace's admitted records.

## License

Apache-2.0.
