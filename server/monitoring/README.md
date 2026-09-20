# Monitoring (local, optional)

Minimal Prometheus + Grafana setup for this backend. Purely observational —
the application starts and works normally with or without either of these
running.

## What's exposed

- `GET /metrics` on the backend (port from `server/.env`, currently `5050`) —
  Prometheus exposition format via `prom-client`.
- Metrics: `http_requests_total`, `http_request_duration_seconds`,
  `cache_hits_total`, `cache_misses_total` (see `server/src/monitoring/metrics.js`).

## 1. Run Prometheus locally (no Docker)

```bash
brew install prometheus   # if not already installed
prometheus --config.file=server/monitoring/prometheus.yml
```

Prometheus UI: http://localhost:9090 — check **Status → Targets** to confirm
the `customer-review-rating-backend` job is `UP`.

If the backend's `PORT` in `server/.env` ever changes, update the target in
`prometheus.yml` to match.

## 2. Run Grafana locally (no Docker)

```bash
brew install grafana      # if not already installed
brew services start grafana
```

Grafana UI: http://localhost:3000 (default login `admin` / `admin`).

## 3. Connect Grafana to Prometheus

1. Configuration → Data sources → Add data source → Prometheus.
2. URL: `http://localhost:9090`.
3. Save & test.

## 4. Import the dashboard

1. Dashboards → New → Import.
2. Upload `server/monitoring/grafana-dashboard.json`.
3. Select the Prometheus data source you just created.

The dashboard has one page with: total requests, request rate, p95 latency,
HTTP error rate, requests/latency over time, and a Redis cache hit/miss/ratio
table for the four cached endpoints (product list, product detail, review
list, admin dashboard).
