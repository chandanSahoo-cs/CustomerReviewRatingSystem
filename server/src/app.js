import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware.js';
import { httpMetricsMiddleware } from './monitoring/httpMetrics.middleware.js';
import { metricsHandler } from './monitoring/metrics.js';
import authRoutes from './modules/auth/auth.routes.js';
import productRoutes from './modules/products/product.routes.js';
import { productReviewsRouter, reviewsRouter } from './modules/reviews/review.routes.js';
import voteRoutes from './modules/votes/vote.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import { reviewReportRouter, adminReportRouter } from './modules/reports/report.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';

const app = express();

// --- Security & core middleware -------------------------------------------------
app.use(helmet());
app.use(
  cors({
    origin: env.clientOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// --- Prometheus HTTP instrumentation (records count/duration/status only) --
app.use(httpMetricsMiddleware);

// --- Health check -----------------------------------------------------------
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok' } });
});

// --- Prometheus scrape endpoint ---------------------------------------------
app.get('/metrics', metricsHandler);

// --- Feature module routes are mounted here as they are implemented. -------
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/products', productRoutes);
// Nested review routes (/:productId/reviews) fall through from
// productRoutes above since it has no matching route of its own.
app.use('/api/v1/products', productReviewsRouter);
app.use('/api/v1/reviews', reviewsRouter);
// /:reviewId/vote doesn't overlap with reviewsRouter's /:reviewId, so both
// can be mounted at the same base path without conflict.
app.use('/api/v1/reviews', voteRoutes);
// /:reviewId/report doesn't conflict with other routes on /api/v1/reviews
app.use('/api/v1/reviews', reviewReportRouter);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin/reports', adminReportRouter);
app.use('/api/v1/notifications', notificationRoutes);

// --- 404 + centralized error handling ---------------------------------------
app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
