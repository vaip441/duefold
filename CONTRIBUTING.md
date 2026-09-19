# Contributing

Duefold is deliberately small. The most useful contributions make it more correct, more accessible, or easier to run.

- **Security problems** go through [SECURITY.md](SECURITY.md), never a public issue.
- **New features:** open an issue first. NDAs, Q&A, engagement analytics, redaction, DRM, public APIs, and plugins are out of scope.
- **Synthetic data only** in code, tests, screenshots, and issues.

## Pull requests

Set up with [docs/development.md](docs/development.md) and run `npm run verify`. If you touched the database, authorization, or the browser client, run those suites too. Keep each pull request focused and mention any effect on security or migrations.

## Rules

- Changes to access control need tests for both the allowed and the denied path.
- Every protected request is authorized on the server. Deny by default.
- Grants only ever add access. There are no deny rules.
- Nothing reaches investors until it's published.
- A security change and its audit event commit in the same transaction.
- Never edit an applied migration. Add a new one.
- Untrusted files are parsed only in the worker sandbox.
- WCAG 2.2 AA and full keyboard support are part of done.
- Interface work follows [DESIGN.md](DESIGN.md).

## License

Contributions are licensed under the [AGPL-3.0-only](LICENSE), like the rest of the project.
