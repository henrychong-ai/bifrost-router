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

## Code Style

- TypeScript throughout
- ESLint 9 flat config — run `pnpm run lint:fix` to auto-fix
- Tests required for new features and bug fixes
- See [CLAUDE.md](CLAUDE.md) for architecture details and coding conventions

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
