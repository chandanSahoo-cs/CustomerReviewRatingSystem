import client from 'prom-client';

/**
 * Minimal Prometheus instrumentation.
 *
 * Scope is intentionally tiny — only what was asked for:
 *   HTTP:  total requests, request duration (for p95), status code
 *          (for 4xx/5xx error rate; rate itself is derived in PromQL).
 *   Cache: hits/misses per cache type (product_list, product_detail,
 *          review_list, admin_dashboard) so Grafana can derive hit ratio.
 *
 * No default Node.js process/CPU/memory metrics, no route labels, no
 * high-cardinality labels (user/product/review IDs, raw URLs). Uses the
 * global prom-client registry — nothing here touches Mongo, Redis
 * connections, auth, or any existing business logic.
 */

export const register = client.register;

// --- HTTP metrics -----------------------------------------------------------

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled by the application.',
  labelNames: ['method', 'status_code'],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds (used to derive p95 latency).',
  labelNames: ['method', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// --- Redis cache metrics ------------------------------------------------------

export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits, labeled by cache type.',
  labelNames: ['cache'],
});

export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses, labeled by cache type.',
  labelNames: ['cache'],
});

/**
 * Records a cache hit or miss for one of the known cache types
 * (product_list, product_detail, review_list, admin_dashboard).
 * Never throws — instrumentation must never affect cache behavior.
 */
export function recordCacheResult(cacheType, isHit) {
  try {
    if (isHit) {
      cacheHitsTotal.inc({ cache: cacheType });
    } else {
      cacheMissesTotal.inc({ cache: cacheType });
    }
  } catch {
    // Instrumentation must never break the request it's observing.
  }
}

/** Express handler for GET /metrics. */
export async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
