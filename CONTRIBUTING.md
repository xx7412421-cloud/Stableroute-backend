# Contributing

Thanks for helping improve StableRoute Backend. This guide keeps small fixes, bounty work, and larger changes easy to review.

## Workflow

1. Fork the repository.
2. Create a branch from `main`.
3. Use a focused branch name:
   - `fix/quote-12-invalid-amount`
   - `feat/routing-18-price-source`
   - `docs/project-docs-23-contributing`
4. Install dependencies:

   ```bash
   npm ci
   ```

5. Make a small, focused change.
6. Run the local checks before opening a pull request:

   ```bash
   npm run build
   npm run lint
   npm test
   ```

7. Open a pull request against `main`.

## Pull Requests

Keep pull requests reviewer-friendly:

- Link the issue being fixed.
- Describe the behavior change and the validation you ran.
- Add or update tests when code behavior changes.
- Keep documentation in sync with commands, environment variables, and API behavior.
- Avoid unrelated refactors in bounty or bug-fix pull requests.

For code changes, keep or improve test coverage. The campaign expectation is 95 percent coverage for impacted modules.

## Issues

Before filing an issue, search existing issues and include enough detail for someone else to reproduce or understand the request.

Bug reports should include:

- What happened.
- What you expected.
- Steps to reproduce.
- Logs or screenshots when useful.
- Node.js and npm versions.

Feature requests should include:

- The user problem.
- The proposed behavior.
- Any API or security considerations.

## Security

Do not commit secrets, private keys, access tokens, `.env` files, or production credentials. Use local environment variables or the deployment platform's secret store.

If a change touches routing, pricing, authentication, or request handling, include a short security note in the pull request that describes the relevant risk and how the change handles it.

## Community and Campaign

StableRoute is part of a GrantFox OSS / Official Campaign. For questions, reviews, and faster feedback, join the StableRoute community on Discord:

https://discord.gg/37aCpusvx
