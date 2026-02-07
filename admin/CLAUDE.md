# Admin Dashboard - CLAUDE.md

> **Note:** For deployment pipeline, CI/CD, API reference, and shared project context, see the root `/CLAUDE.md`.

Admin dashboard for Bifrost edge router. React SPA built with Vite, Tailwind CSS, and shadcn/ui.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React 19 SPA |
| Build | Vite 7 |
| Styling | Tailwind CSS 4 + shadcn/ui |
| State | TanStack Query |
| Routing | React Router v7 |
| Forms | React Hook Form + Zod |
| Charts | Recharts (via shadcn/ui chart) |
| Tables | @tanstack/react-table (via shadcn/ui) |

## Development Commands

```bash
# From repo root
pnpm --filter admin dev      # Start dev server on port 3001
pnpm --filter admin build    # Production build
pnpm --filter admin preview  # Preview production build
```

## Project Structure

```
admin/
├── src/
│   ├── components/
│   │   ├── ui/           # shadcn/ui components
│   │   ├── layout/       # Sidebar, header, page layout
│   │   ├── routes/       # Route management components
│   │   ├── analytics/    # Analytics components
│   │   └── common/       # Shared components
│   ├── hooks/            # TanStack Query hooks
│   ├── lib/
│   │   ├── api-client.ts # Type-safe API client
│   │   ├── schemas.ts    # Zod schemas (imported from parent)
│   │   └── utils.ts      # Utility functions
│   ├── pages/            # Route pages
│   ├── App.tsx           # Root with router
│   └── main.tsx          # Entry point
├── Dockerfile
├── docker-compose.yml
└── nginx.conf
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Admin API base URL (e.g., https://bifrost.example.com) |
| `VITE_ADMIN_API_KEY` | Admin API key for authentication |

## Docker Container Architecture

The `:tailscale` image includes:
1. **nginx** - Serves the React SPA on localhost:3001
2. **tailscaled** - Runs in userspace networking mode
3. **Tailscale Serve** - Proxies HTTPS traffic to nginx

Container authenticates to your tailnet as `bifrost.<your-tailnet>.ts.net` using the auth key from `auth.env`.

### Configuration Files

| File | Purpose |
|------|---------|
| `Dockerfile.tailscale` | Multi-stage build with Tailscale |
| `docker-compose.tailscale.yml` | Production deployment config |
| `scripts/start-with-tailscale.sh` | Container startup script |

## Implementation Notes

### Domain Parameter Handling (v1.8.2)

When mutating routes, the dashboard must pass the correct domain:

```typescript
// In routes.tsx handlers - use fallback for single-domain view
await toggleRoute.mutateAsync({
  path: route.path,
  enabled: !route.enabled,
  domain: route.domain ?? filters.domain  // Fallback to active filter
});
```

**Why?** Single-domain API responses include `domain` on each route (backend fix), but the fallback ensures correct behavior if the field is missing.

### API Client Query Parameters

All single-route operations use query parameters (not path parameters):

```typescript
// In api-client.ts
const url = new URL(`${this.baseUrl}/api/routes`);
url.searchParams.set('path', path);
if (domain) url.searchParams.set('domain', domain);
```

This avoids URL encoding issues with special characters (`/`, `*`, etc.) in route paths.
