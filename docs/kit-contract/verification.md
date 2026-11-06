# Local baseline verification

InventArch, 2026-11-06. This records development evidence for issue 21, not publication clearance or a checker-conformance receipt.

Commit order is `990a90d` (spec and observed missing-artifact tests), then `84bbec4` (independent adversarial review and strengthened controls), then the artifact implementation. Immediately before adding the artifacts, the final suite reported 17 failures and one passing UTF-8 control. After adding the reviewed expectation data and normative context without changing the tests, `node --test tests/kit-contract-baseline.test.mjs` passed **18/18**, zero skips, in **134.524 ms** on Node 22.23.4.

The three pins in review.md and the tests match the copied artifacts. The four contracts retain 14 requirements and 163 case declarations; all 177 requirement/case evaluator fields remain unavailable. The 18 integrity tests are not executions of those 163 scenarios.

Repository consistency against origin/main passes. Pinned CLI 3.5.0 language checking admits the repository work records and the three existing bundled kits, each with zero errors and two warnings. It does not admit the proposed JSON contracts or execute their evaluators. The existing validation, selection, bundle, index, package, release-note and lint hooks pass. Plugin, kit and package payloads are unchanged; no shipped release note or version cut is needed for these repository-only documents and tests. Full unrelated runtime/host suites were not rerun for this data-only change.

The native task remains open. CAT-06 is not evaluated because its authoritative operator-maintained private-identity list is unavailable. Public approval evidence, exact catalogue imports, native lowering, executable checker qualification and release-consumer integration remain unresolved. Keep this branch local until authorized screening covers its complete publication payload. No push, PR, merge, release, adoption or public-baseline freeze is claimed.
