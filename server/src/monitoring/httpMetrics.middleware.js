import { httpRequestsTotal, httpRequestDurationSeconds } from './metrics.js';

/**
 * Smallest possible instrumentation middleware: records request count,
 * duration, and status code. Never modifies req/res, never throws, and
 * never delays the response — all work happens on the 'finish' event
 * after Express has already sent the response.
 *
 * The /metrics endpoint itself is excluded so Prometheus's own scrapes
 * don't distort the application's request metrics.
 */
export function httpMetricsMiddleware(req, res, next) {
  if (req.path === '/metrics') {
    return next();
  }

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const labels = { method: req.method, status_code: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(labels, durationSeconds);
    } catch {
      // Instrumentation must never affect the actual request/response.
    }
  });

  next();
}
