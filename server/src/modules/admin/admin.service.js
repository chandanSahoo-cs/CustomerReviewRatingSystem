import Product from '../products/product.model.js';
import Review from '../reviews/review.model.js';
import User from '../users/user.model.js';
import { getCache, setCache } from '../../services/cache.service.js';
import { recordCacheResult } from '../../monitoring/metrics.js';

const DASHBOARD_CACHE_KEY = 'admin:dashboard';
const RECENT_LIMIT = 5;

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Maps a Product document (or `.lean()` object) to its dashboard shape. */
function toRecentProduct(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    price: doc.price,
    image: doc.image ?? null,
    ratingStats: doc.ratingStats,
    createdAt: doc.createdAt,
  };
}

/**
 * Maps a Review document (with `userId` populated with just `{ _id, name
 * }`) to its dashboard shape. Never exposes passwordHash — only `name`
 * is ever selected on the populated user.
 */
function toRecentReview(doc) {
  const rawUser = doc.userId;
  const userIsPopulated = rawUser && typeof rawUser === 'object' && rawUser.name !== undefined;
  const user = userIsPopulated ? { id: rawUser._id.toString(), name: rawUser.name } : { id: rawUser?.toString() };

  const rawProduct = doc.productId;
  const productIsPopulated = rawProduct && typeof rawProduct === 'object' && rawProduct.name !== undefined;
  const product = productIsPopulated
    ? { id: rawProduct._id.toString(), name: rawProduct.name, slug: rawProduct.slug }
    : { id: rawProduct?.toString(), name: null };

  return {
    id: doc._id.toString(),
    productId: product.id,
    productName: product.name,
    user,
    rating: doc.rating,
    title: doc.title,
    createdAt: doc.createdAt,
  };
}

/**
 * Builds the admin dashboard from count/aggregation queries only — never
 * loads the full Product/Review/User collections into memory. The
 * result is cached as a single blob under `admin:dashboard`; the
 * Products, Reviews, and Votes modules each invalidate this key whenever
 * they mutate data the dashboard depends on.
 */
export async function getDashboard() {
  const cached = await getCache(DASHBOARD_CACHE_KEY);
  recordCacheResult('admin_dashboard', Boolean(cached));
  if (cached) return cached;

  const [[productAgg], [reviewAgg], totalCustomers, recentProductsRaw, recentReviewsRaw] = await Promise.all([
    Product.aggregate([
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          weightedRatingSum: { $sum: { $multiply: ['$ratingStats.average', '$ratingStats.count'] } },
          totalRatingCount: { $sum: '$ratingStats.count' },
          distOne: { $sum: '$ratingStats.distribution.one' },
          distTwo: { $sum: '$ratingStats.distribution.two' },
          distThree: { $sum: '$ratingStats.distribution.three' },
          distFour: { $sum: '$ratingStats.distribution.four' },
          distFive: { $sum: '$ratingStats.distribution.five' },
        },
      },
    ]),
    Review.aggregate([
      {
        $group: {
          _id: null,
          totalReviews: { $sum: 1 },
          totalUpvotes: { $sum: '$voteStats.upvotes' },
          totalDownvotes: { $sum: '$voteStats.downvotes' },
        },
      },
    ]),
    User.countDocuments({ role: 'customer' }),
    Product.find().sort({ createdAt: -1 }).limit(RECENT_LIMIT).lean(),
    Review.find()
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT)
      .populate('userId', 'name')
      .populate('productId', 'name slug')
      .lean(),
  ]);

  const totalRatingCount = productAgg?.totalRatingCount ?? 0;
  const averageProductRating =
    totalRatingCount > 0 ? round2((productAgg?.weightedRatingSum ?? 0) / totalRatingCount) : 0;

  const dashboard = {
    totals: {
      products: productAgg?.totalProducts ?? 0,
      reviews: reviewAgg?.totalReviews ?? 0,
      customers: totalCustomers,
    },
    averageProductRating,
    votes: {
      upvotes: reviewAgg?.totalUpvotes ?? 0,
      downvotes: reviewAgg?.totalDownvotes ?? 0,
    },
    ratingDistribution: {
      one: productAgg?.distOne ?? 0,
      two: productAgg?.distTwo ?? 0,
      three: productAgg?.distThree ?? 0,
      four: productAgg?.distFour ?? 0,
      five: productAgg?.distFive ?? 0,
    },
    recentProducts: recentProductsRaw.map(toRecentProduct),
    recentReviews: recentReviewsRaw.map(toRecentReview),
  };

  await setCache(DASHBOARD_CACHE_KEY, dashboard);
  return dashboard;
}

const INSIGHTS_CACHE_KEY = 'admin:product-insights';
const INSIGHTS_CACHE_TTL = 60 * 60; // 1 hour (in seconds)

/**
 * Returns every product's AI-generated review insights (summary +
 * sentiment breakdown + lastGeneratedAt). Admin-only — never exposed
 * to public product endpoints. The result is cached for 1 hour; the
 * nightly cron job invalidates it after each run.
 */
export async function getProductInsights() {
  const cached = await getCache(INSIGHTS_CACHE_KEY);
  if (cached) return cached;

  const products = await Product.find(
    { 'ratingStats.count': { $gt: 0 } },
    { _id: 1, name: 1, slug: 1, ratingStats: 1, aiInsights: 1 }
  )
    .sort({ 'ratingStats.count': -1 }) // most-reviewed first
    .lean();

  const insights = products.map((p) => ({
    id: p._id.toString(),
    name: p.name,
    slug: p.slug,
    reviewCount: p.ratingStats?.count ?? 0,
    averageRating: p.ratingStats?.average ?? 0,
    aiInsights: {
      summary: p.aiInsights?.summary ?? null,
      sentiment: p.aiInsights?.sentiment ?? { positive: 0, neutral: 0, negative: 0 },
      isGibberish: p.aiInsights?.isGibberish ?? false,
      lastGeneratedAt: p.aiInsights?.lastGeneratedAt ?? null,
    },
  }));

  // Use a shorter TTL here since insights change daily.
  await setCache(INSIGHTS_CACHE_KEY, insights, INSIGHTS_CACHE_TTL);
  return insights;
}

export default { getDashboard, getProductInsights };
