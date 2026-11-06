# Publisher screening development evidence

InventArch, 2026-11-06. Issues 22 and 23; plan kit-contract-qualification. This evidence concerns the controlled frozen-text screening tool, not operator registry acceptance, public baseline approval, kit conformance or publication authority.

The test-first sequence retains initial missing-tool failures (d738f64: 30 tests), independent spec/test review (1a73faf: 48 missing-tool failures), then independently reviewed implementation regressions. Commits 05b7f9a and 28b528e retain the path/status/linked-CLI/manifest-precedence failures before correction; 0e9fa96 retains the review. Commits 950560a and d375cf1 retain stdin-import and row-type failures; 9dec039 retains their review before correction. The last red suite had 68 controls, 66 passing and two failing, with zero skips.

After the fixes, `node --test tests/check-identities.test.mjs tests/kit-contract-baseline.test.mjs` reports **86/86 passing**, zero skips, in **5606.1015 ms** on Node 22.23.4, Windows. Of those, 68 exercise the screening contract and 18 check baseline integrity. These do not execute the baseline's 163 conformance scenarios. Baseline expectation and context files are unchanged.

Consistency against the recorded base a7b2d54f2d12798ced42452f95e6c058d26a80f2 passes. Pinned CLI 3.5.0 language admission reports zero errors and two warnings for each of the repository records and three existing bundled kits. Repository validation, selection, bundle, index, package, release-note and lint hooks pass on the preceding commits; the implementation commit runs them again. No plugin/package payload changed, so this repository maintainer tool does not cut a shipped release.

Independent reviewers confirmed the concrete regressions. Internal adversarial review accepted the first corrections and then found the import/type defects retained above. The next exact-source review is retained separately before publication readiness is claimed. Filesystem race resistance, exact bigint identity hardening, high-token-count performance and full kit-format coverage are tracked in issue 23; this profile assumes a controlled frozen snapshot and fails closed for unsupported inputs. The tool is not wired into the packer yet.

The issue 22 task stays open. The sensitive operator registry is external, its acceptance remains a separate prerequisite, and CAT-06 publication clearance is not claimed. No public push, PR, merge, release or baseline freeze is authorized by these tests.
