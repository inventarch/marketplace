# IA Slack Base Kit (`inventarch/ia-slack-base-kit`)

Public `Apache-2.0` base kit for Slack space settings and channel governance in an IA workspace. It declares `slack-system` (`0.1.0`), its uniform steward (`@agent slack-system-steward`) and stewardship mandate (`@mandate slack-system-stewardship`), the canonical `@slack-channel` schema and authoring guide, the five public channel governance rules, and the offline `check-slack-channels` verifier.

## Minted Vocabulary

- `@slack-channel` — one Slack space (channel, group conversation, or direct conversation) bound to an `@workspace`: per-message `slack.label` and optional `slack.icon`, `slack.channel` and optional `slack.channel-id`, `slack.workspace` and `slack.home`, checkpoint `slack.approver` and allowed `slack.members` Slack user identifiers, serving `slack.app` (`organisation` or `person`), opaque `slack.secret` reference name, optional `slack.answers` (`off` or `on`), read allow-list (`slack.sources` and `slack.shows`), `slack.kind` (`design-channel`, `coordination-space`, `direct`), `slack.form` (`channel`, `group`, `direct`), allowed `slack.asks` (`status`, `decision`, `space`), `slack.rate` cap, `slack.creation` (`app` or `person`), and `slack.disclosure` (`link-only` default, or `content`).

See [assets/slack-vocabulary.md](assets/slack-vocabulary.md) for the field contract, the five public Slack channel governance rules, and the offline checker invariants.

## Compatibility Rule

No workspace may compose another system that mints `slack-channel`. Organisation and workspace repositories stand on `inventarch/ia-slack-base-kit` to validate `@slack-channel` settings 100% offline with `@inventarch/cli@3.10.0` and `inventarch/language` (`^3.0.0`, locked at `3.2.0`), while live Slack Socket Mode connections, directory bindings, and answering runtimes stay outside the public base kit.

## Declared Checks (`checks.json`)

- `slack-check-validate`: runs `ia validate --json` in the workspace through the resolved CLI.
- `check-slack-channels`: runs `scripts/check-slack-channels.mjs` offline over the workspace's admitted records.

## License

Apache-2.0.
