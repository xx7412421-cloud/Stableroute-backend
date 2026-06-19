# stableroute-backend

API gateway, routing engine, and pricing service for [StableRoute](https://github.com/your-org/stableroute) — Stellar liquidity routing.

## What this repo contains

- **Express** REST API (TypeScript)
- **Health** and **quote** endpoints as a base for the routing engine and pricing service

## Prerequisites

- Node.js 18+
- npm

## Setup (contributors)

1. Clone the repo and enter the directory:
   ```bash
   git clone <repo-url> && cd stableroute-backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build and test:
   ```bash
   npm run build
   npm test
   ```
4. Run locally:
   ```bash
   npm run dev
   ```
   API: `http://localhost:3001` (or `PORT` env var).

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run production server (`dist/index.js`) |
| `npm run dev` | Run with ts-node-dev (watch) |
| `npm test` | Run Jest tests |
| `npm run lint` | Run ESLint |

## CI/CD

On every push/PR to `main`, GitHub Actions runs:

- `npm ci`
- `npm run build`
- `npm test`

Ensure these pass locally before pushing.

## Error responses

Handlers use a shared `sendError` helper so 400/404/413/500-style responses keep the canonical `{ error, message, requestId }` shape. The request id is attached before JSON parsing, which keeps body-parser errors correlated with the `X-Request-Id` response header.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, branch naming, local checks, and PR expectations.

Quick checklist:

1. Fork the repo and create a branch from `main`.
2. Install deps, add tests for new behavior, keep `npm run build`, `npm run lint`, and `npm test` passing.
3. Open a PR; CI must be green.

## License

MIT
