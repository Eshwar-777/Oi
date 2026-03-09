# AGENTS.md

Guidance for coding agents working agent-browser.

## Tooling

Use `pnpm` for package management and scripts. Do not swap in `npm` or `yarn`.

Examples:

```bash
pnpm install
pnpm run build
```

## Output and style rules

- Avoid emojis in code, generated output, and docs.
- If CLI color is needed, route it through `cli/src/color.rs`.
- Respect `NO_COLOR`; never embed raw ANSI escape sequences directly.
- Command-line flags should stay kebab-case, such as `--auto-connect`.

## Documentation update policy

Any user-facing change must be reflected everywhere users or agents would look for it.

When commands, flags, environment variables, or visible behavior change, update:

1. `cli/src/output.rs`
2. `README.md`
3. `skills/agent-browser/SKILL.md`
4. `docs/src/app/`
5. Relevant inline source documentation

For MDX docs under `docs/src/app/`, prefer HTML `<table>` markup instead of markdown tables.

## Two implementation paths

This project currently has two browser-control implementations:

- Node.js / Playwright
- Rust / native

Changes to command behavior should be mirrored in both paths unless the native side is intentionally left incomplete with an explicit not-implemented error.

Key file mapping:

- `src/actions.ts` <-> `cli/src/native/actions.rs`
- `src/browser.ts` <-> `cli/src/native/browser.rs`
- `src/daemon.ts` <-> `cli/src/native/daemon.rs`
- `src/protocol.ts` <-> `cli/src/native/cdp/client.rs`
- `src/snapshot.ts` <-> `cli/src/native/snapshot.rs`
- `src/state-utils.ts` <-> `cli/src/native/state.rs`

## Validation

### Unit tests

```bash
cd cli && cargo test
```

These are fast and do not require a browser installation.

### End-to-end coverage

```bash
cd cli && cargo test e2e -- --ignored --test-threads=1
```

Notes:

- Chrome must be available
- Tests need to run serially
- The e2e suite is ignored by default

The end-to-end coverage lives in `cli/src/native/e2e_tests.rs` and exercises the native daemon flow across core browser actions.

### Formatting and linting

```bash
cd cli && cargo fmt -- --check
cd cli && cargo clippy
```

## Vendored source references

Dependency source snapshots are available in `opensrc/` for implementation-level inspection.

Use `opensrc/sources.json` to see what is already present.

When more source is needed:

```bash
npx opensrc <package>
npx opensrc pypi:<package>
npx opensrc crates:<package>
npx opensrc <owner>/<repo>
```
