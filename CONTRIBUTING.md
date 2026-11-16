# Contributing to Bifrost

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Start the dev server: `pnpm run dev`

See the [Fork & Deploy Guide](README.md#fork--deploy-guide) in the README for full setup instructions including Cloudflare resource creation.

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run the full test suite: `pnpm run test`
4. Run linting: `pnpm run lint`
5. Run type checking: `pnpm run typecheck`
6. Submit a pull request

## Keeping the repository public-safe

This repository is public, and `pnpm run public:check` (in `pnpm run check` and CI) fails on private content: home-directory paths, private host names, non-example email addresses, real cloud identifiers (use `your-…` placeholders), and unpinned binary files. A `commit-msg` hook applies the same rules to each commit message (and to the author and committer names), and CI checks the commits a push or pull request adds. Your git email is not checked unless a repository opts in. The hooks need Node on `PATH`; a git client that runs hooks without it cannot commit.

**Opt-in commit email rule.** With `PUBLIC_CHECK_COMMIT_EMAILS=noreply` (in your environment, or as a repository variable for CI) or a `commit-emails: noreply` line in your terms file (below), author and committer emails, and addresses in commit messages, must be GitHub no-reply or example-domain addresses. To keep your email out of a public history, set it to your GitHub no-reply address (`git config user.email <id>+<user>@users.noreply.github.com`).

**Your own private names.** Any fork can add its own terms (company, people, host or ticket names) without committing them: put one term per line in `.git/public-check-terms.txt` (in a worktree, the directory `git rev-parse --git-common-dir` prints), or point `PUBLIC_CHECK_TERMS_FILE` at a file. Lines starting `#` are comments; a term matches case-insensitively anywhere in a line; a line starting `re:` is a regular expression (`re:\bABC-\d+\b` for ticket keys); the line `commit-emails: noreply` is a directive, not a term, and turns on the commit email rule for your clone. Terms match within one line, so write a multi-word name as `re:acme[\s._-]?corp`. The file and the hooks read it locally only; findings name the file's line, never the term.

**Pre-push check.** With a terms file in place, a `pre-push` hook runs the whole file check and the commit check over the commits being pushed, with your terms. Without a terms file it does nothing, so a fork that commits its own real values is never blocked from pushing.

## Code Style

- TypeScript throughout
- Oxlint lints and Biome formats — `pnpm run lint:fix` and `pnpm run format` fix what they can
- Tests required for new features and bug fixes
- See [AGENTS.md](AGENTS.md) for architecture details and coding conventions

## Build Dependencies

The `shared` package must be built before `mcp`:

```bash
pnpm -C shared build   # Build first
pnpm -C mcp build      # Then MCP
```

## Reporting Issues

Use [GitHub Issues](https://github.com/henrychong-ai/bifrost-router/issues) with the provided templates for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
