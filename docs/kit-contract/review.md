# Baseline specification and test review

InventArch, 2026-11-06. Scope: local proposed expectation baseline for issue 21. This is a development review record, not an authenticated public approval receipt or publication-screening result.

The first commit, `990a90d`, contains the spec, native work records and failing integrity tests before either baseline artifact was added. The observed run had 12 failures and no skips: missing expectation/context artifacts failed explicit assertions, not module imports. The repository hooks passed, including pinned-language admission of the native work records. This does not admit the proposed contract JSON as native records.

Independent semantic review verified all four contract identities, 14 requirements and 163 case identities and associations. It requested explicit catalogue ownership and precise progress definitions, including assessed-but-unresolved standing; both corrections were made and rereviewed. Separate test-adequacy and privacy/compatibility reviews verified inert reads, fixed pins and the limited integrity claim. No plugin, kit or package payload changes are part of this slice.

The internal adversarial review then identified a substantive ambiguity: JSON.parse discards earlier duplicate object keys, so contradictory raw text could retain the parsed semantic digest. Three independent verifiers reproduced or confirmed it. The strengthened tests bind exact UTF-8 expectation text as well as parsed semantics, demonstrate the duplicate-key counterexample and reject it. Strict decoding preserves a BOM and rejects malformed UTF-8; CRLF-to-LF is the only text normalization.

The review also led to context mutation/CRLF controls, independent structural negative controls, precise ECMAScript canonicalization wording, and clarification that fixed digest constants do not authenticate independent approval. Hypothetical programme examples are explicitly distinguished from observations of a real inventory. The release requirement is stated as proposed semantics without implying an external public ruling.

Three independent verifiers rejected proposed changes to optional grammar metadata and programme variant IDs. The required association survives in the case identity and given text; optional metadata was not present in every original case. Inventing metadata, deleting a retained grammar reference or renaming stable programme IDs would change the expectations to suit a hypothetical implementation. The public context now states this constraint. Joint review and full pins cover duplicated normative passages; no generic schema validator or conformance engine is claimed.

The strengthened pre-artifact run had 17 tests: one strict-decoding control passed and 16 artifact-dependent tests failed, with no skips. Both red observations are retained as development evidence. The internal rereview approved the local proposal with minor improvements: a standalone exact-text assertion, hypothetical context wording, BOM controls and additional structural controls. These are included in the final 18-test suite. Progress definitions retain the governing source meaning; a suggested rewrite to a narrower not-started meaning was not adopted.

The subsequent artifact commit, `72a4274`, made all 18 pass without changing these reviewed expectations. The independent verifier recomputed all three pins and executed the earlier 17-test body against the scratch proposal successfully; that is a pre-artifact diagnostic, distinct from repository green. Final artifact verification is recorded in [verification.md](verification.md).

The final internal rereview approved the local proposed baseline with no blocking, medium or minor defects. Its two documentation nits are resolved by linking the green evidence and naming the development review records separately from normative inputs. Full repository/runtime gates remain required before a future PR; no PR or publication is attempted while screening is unavailable. A separate verifier confirmed exact scratch-to-repository byte equality, all three pins, the four-contract inventory and 18/18 passing repository tests with no skips.

Current review pins:

| Input | SHA-256 |
|---|---|
| Complete expectation text, LF-normalized | `99a2bbc49c2575b42ef2d4522d572955af3e1332db54fc87861dbc7e6f726c1e` |
| Complete normative context, LF-normalized | `c6278e3d61f2773759b176e562b01eee4565ff67098d0ef30c453180f98a6d1d` |
| Supplementary parsed semantic value | `71e0ed8a712a27d0ff32c8076b033f5cc4880e07a5015212303dad3ce77534f7` |

At this development-review checkpoint, the authoritative operator-maintained private-identity list was unavailable and CAT-06 was **not evaluated**. Subsequent operator acceptance and exact-payload screening evidence are retained privately by the publisher; this historical review is not their receipt. Neither successful integrity tests nor these development reviews freeze an adopted public contract, authenticate public oracle approval, qualify the checker, clear publication, or permit a new kit release.
