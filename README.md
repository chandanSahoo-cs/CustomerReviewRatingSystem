# Customer Review & Rating Management System

A professional, modular, scalable **Customer Review & Rating Management System**
built on the MERN stack. This is **not** a CRM — it is a product catalog + review/rating
platform with exactly two user roles.

> **Status:** Project foundation only. No features (auth, products, reviews, votes,
> dashboard) have been implemented yet — see [Current status](#current-status).

## Roles

- **Customer** — register/login, browse products, view product details, view reviews
  and ratings, create a review with a 1–5 star rating, edit/delete their own reviews,
  upvote/downvote reviews.
- **Admin** — login, view dashboard/analytics, create/update/delete products,
  view/manage reviews.

## Architecture

**Modular monolith.** One React frontend, one Express backend, MongoDB Atlas as the
source of truth, Redis used strictly as a cache. JWT-based stateless authentication.

```
Route → Middleware → Controller → Service → Mongoose Model → MongoDB
```

- Controllers stay thin; business logic lives in services.
- No repository layer, no CQRS, no event sourcing, no microservices, no message
  queues (Kafka/RabbitMQ, etc.).
- Frontend is a single app with role-based routing — **not** separate customer/admin
  apps.

### Repository layout

```
CustomerReviewRatingSystem/
├── client/    React (Vite) frontend — customer + admin experiences, role-based routing
├── server/    Express backend — modular monolith, /api/v1
└── README.md
```

### Backend module layout (target — filled in incrementally)

```
server/src/
├── config/          env, MongoDB, Redis connections
├── modules/         auth, users, products, reviews, votes, admin
│                    (each owns its model, controller, service, routes, validation)
├── middleware/       auth, admin, validation, rate limiting, centralized error handling
├── services/        cache.service.js (centralized Redis cache access)
├── utils/           ApiError, ApiResponse, asyncHandler, pagination
├── app.js
└── server.js
```

### Frontend module layout (target — filled in incrementally)

```
client/src/
├── app/             App.jsx, routes.jsx, providers.jsx
├── components/      ui/, layout/, common/
├── features/        auth, products, reviews, votes, dashboard
├── pages/           customer/, admin/
├── layouts/         CustomerLayout.jsx, AdminLayout.jsx
├── services/        apiClient.js (Axios instance)
└── utils/
```

### Routing

Frontend (role-based, single app):

```
/products
/products/:productId
/admin/dashboard
/admin/products
/admin/reviews
```

Backend API (versioned):

```
/api/v1/auth/...
/api/v1/products/...
/api/v1/products/:productId/reviews
/api/v1/reviews/:reviewId
/api/v1/reviews/:reviewId/vote
/api/v1/admin/dashboard
```

### Data model (MongoDB Atlas)

Four collections: `users`, `products`, `reviews`, `votes`. `Product.ratingStats`
(average, count, distribution) is intentionally denormalized and is maintained by
review mutations (with transactions where a review and product stats must stay
consistent) rather than recomputed from all reviews on every request.

### Caching

Redis is **only** a cache — never primary storage, sessions, rate limiting, or
messaging — accessed through a centralized cache service. Candidates: product
list/detail, product reviews, admin dashboard stats, invalidated on writes.

### Auth & security

Stateless JWT (minimal payload: `sub`, `role`, `iat`, `exp`) delivered via
HttpOnly + Secure + SameSite cookies. Passwords hashed with bcrypt/Argon2id.
Backend authorization is authoritative; frontend guards are UX-only. Helmet, CORS,
input validation, centralized error handling, request body size limits, and
rate limiting on the login endpoint (via `express-rate-limit`, in-memory — not Redis).

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

**Frontend:** React, Vite, React Router, TanStack Query, Axios, React Hook Form, Zod,
Tailwind CSS.

**Backend:** Express, Mongoose (MongoDB Atlas), Redis (cache only), JWT auth (added
with the auth module), Helmet, CORS, express-rate-limit (added with the auth module).

## Getting started

Requires Node.js 18+.

```bash
npm install          # installs client + server workspaces
npm run dev:server   # start the Express API (needs MongoDB + Redis reachable)
npm run dev:client   # start the Vite dev server
```

Copy the example env files and fill in real values before running anything that
needs a database or cache:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

## Current status

This repository currently contains **only the project foundation**:

- Root npm workspace wiring `client` and `server`.
- `server`: Express app bootstrap (`app.js`/`server.js`), env/DB/Redis config,
  centralized error handling, a generic cache service, and shared utils
  (`ApiError`, `ApiResponse`, `asyncHandler`). A single `/api/v1/health` route
  exists to verify the server boots.
- `client`: Vite + React + Tailwind CSS app shell (`app/App.jsx`, `routes.jsx`,
  `providers.jsx` with TanStack Query, and a shared Axios `apiClient`), with a
  single placeholder route.




