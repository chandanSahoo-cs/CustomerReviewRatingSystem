# Customer Review & Rating Management System

A full-stack **product catalog + review & rating platform** built on the MERN
stack, with AI-assisted review insights and optional local monitoring. Built as
a modular monolith with exactly two user roles: **Customer** and **Admin**.

## Features

**Customer**
- Register / login (JWT, HttpOnly cookies) and view profile
- Browse products with cursor-based pagination and search
- View product details, aggregate rating stats, and AI-generated review summaries
- Create, edit, and delete their own reviews (1–5 star rating + title + body)
- Upvote / downvote reviews
- Report inappropriate reviews
- Receive notifications (e.g. when a reported review is actioned)

**Admin**
- Dashboard with product/review/customer totals, rating distribution, and vote counts
- Full product management (create, update, delete)
- Review moderation via user reports (approve → removes review, dismiss)
- Per-product AI review insights (summary + sentiment), generated nightly

**Platform**
- AI-generated review summaries and sentiment via Google Gemini (scheduled cron job)
- Redis caching (cache-aside) for hot read paths, with targeted invalidation on writes
- Optional local Prometheus + Grafana monitoring (HTTP + cache metrics)

## Architecture

**Modular monolith.** One React frontend, one Express backend, MongoDB as the
source of truth, Redis used strictly as a cache. JWT-based stateless authentication.

```
Client → Route → Middleware (auth/role) → Controller → Service → Model → MongoDB / Redis
```

- Controllers stay thin; business logic lives in services.
- Each backend module (`auth`, `products`, `reviews`, `votes`, `admin`, `reports`,
  `notifications`) owns its own model, service, controller, routes, and validation.
- No repository layer, no CQRS, no event sourcing, no message queues.
- Frontend is a single app with role-based routing — not separate customer/admin apps.

### Repository layout

```
CustomerReviewRatingSystem/
├── client/    React (Vite) frontend — customer + admin experiences
├── server/    Express backend — modular monolith, /api/v1
└── README.md
```

### Backend module layout

```
server/src/
├── config/          env, MongoDB, Redis connections
├── modules/         auth, users, products, reviews, votes, admin, reports, notifications
├── middleware/      auth, admin/customer role guards, validation, rate limiting, error handling
├── services/        cache.service.js, gemini.service.js, reviewSummary.cron.js
├── monitoring/       Prometheus metrics (HTTP + cache), /metrics endpoint
├── utils/           ApiError, ApiResponse, asyncHandler, cursor pagination
├── scripts/         seed scripts (admin, products, full dataset)
├── app.js
└── server.js
```

### Frontend module layout

```
client/src/
├── app/             App.jsx, routes, providers
├── components/      ui/, common/
├── context/         Auth, Toast, etc.
├── features/        auth, products, reviews, votes, admin, reports, notifications
├── layouts/         CustomerLayout, AdminLayout
├── services/        apiClient.js (Axios instance)
└── utils/
```

### Data model (MongoDB)

Core collections: `users`, `products`, `reviews`, `votes`, `reports`, `notifications`.
`Product.ratingStats` (average, count, distribution) and `Review.voteStats` are
intentionally denormalized and kept in sync atomically (via MongoDB transactions)
whenever a review or vote mutation occurs, rather than recomputed on every request.

### Caching

Redis is **only** a cache — never primary storage, sessions, rate limiting, or
messaging — accessed through a centralized cache service using a cache-aside
pattern. Cached: product list/detail, per-product review list, and the admin
dashboard, each invalidated on the writes that affect them.

### Auth & security

Stateless JWT (minimal payload: `sub`, `role`) delivered via HttpOnly + SameSite
cookies. Passwords hashed with bcrypt. Role-based route guards (`customer`/`admin`)
plus resource-ownership checks (e.g. a review can only be edited by its author).
Helmet, CORS (single allowed origin, credentialed), input validation via Zod,
centralized error handling, request body size limits, and rate limiting on the
login endpoint.

### API response format

```json
// Success
{ "success": true, "data": {} }

// Paginated
{ "success": true, "data": [], "pagination": {} }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }
```

## Tech stack

**Frontend:** React, Vite, React Router, TanStack Query, Axios, React Hook Form,
Zod, Tailwind CSS.

**Backend:** Express, Mongoose (MongoDB), Redis (cache only), JWT auth, bcrypt,
Zod, Helmet, CORS, express-rate-limit, node-cron, Google Generative AI (Gemini).

**Monitoring (optional, local-only):** prom-client, Prometheus, Grafana.

## Getting started

Requires Node.js 18+, MongoDB, and Redis.

```bash
npm install          # installs client + server workspaces
```

Copy the example env files and fill in real values (Mongo URI, JWT secret, etc.)
before running anything that needs a database or cache:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Run each app in its own terminal:

```bash
npm run dev:server   # start the Express API (needs MongoDB + Redis reachable)
npm run dev:client    # start the Vite dev server
```

Optional: seed the database with demo data.

```bash
npm run seed --workspace server         # full demo dataset
npm run seed:admin --workspace server   # just an admin user
```

## Monitoring (optional)

A minimal Prometheus + Grafana setup is available under `server/monitoring/`
(HTTP request/latency/error metrics and Redis cache hit/miss ratios). It runs
entirely locally, with no Docker required, and is completely optional — the
application works normally with or without it. See `server/monitoring/README.md`
for setup steps.
