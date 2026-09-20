import mongoose from 'mongoose';
import Review from './review.model.js';
import Product from '../products/product.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { getCache, setCache, deleteCache, deleteCacheByPrefix } from '../../services/cache.service.js';
import { CURSOR_SORT, parsePaginationParams, buildCursorFilter, buildPaginationMeta } from '../../utils/pagination.js';
import { recordCacheResult } from '../../monitoring/metrics.js';

const REVIEW_LIST_CACHE_PREFIX = 'reviews:list:';
// Matches the key format product.service.js uses for its own detail cache.
// Kept as a small local constant (rather than importing from the Products
// module) so the two feature modules stay loosely coupled; this is the
// smallest possible integration needed to invalidate that cache entry.
const PRODUCT_DETAIL_CACHE_PREFIX = 'products:detail:';
// Same reasoning as above: matches product.service.js's own list-cache key
// format. Product list pages embed `ratingStats`, so they must also be
// invalidated whenever a review mutation changes it. Not scoped to a
// single product (list pages mix products), same as product.service.js's
// own `invalidateProductCaches` does for its own writes.
const PRODUCT_LIST_CACHE_PREFIX = 'products:list:';
// Matches the key the Admin module caches its dashboard under. Kept as a
// small local constant (rather than importing from the Admin module) so
// the two feature modules stay loosely coupled — this is the minimal
// hook needed so review mutations don't leave a stale dashboard cached.
const ADMIN_DASHBOARD_CACHE_KEY = 'admin:dashboard';

// Maps a 1-5 rating to its Product.ratingStats.distribution bucket key.
const RATING_BUCKET_KEYS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };

function buildReviewListCacheKey(productId, limit, rawCursor) {
  return `${REVIEW_LIST_CACHE_PREFIX}product=${productId}:limit=${limit}:cursor=${rawCursor || 'none'}`;
}

function buildReviewListCachePrefixForProduct(productId) {
  return `${REVIEW_LIST_CACHE_PREFIX}product=${productId}:`;
}

function buildProductDetailCacheKey(productId) {
  return `${PRODUCT_DETAIL_CACHE_PREFIX}${productId}`;
}

async function invalidateReviewListCache(productId) {
  await deleteCacheByPrefix(buildReviewListCachePrefixForProduct(productId));
}

async function invalidateProductDetailCache(productId) {
  await deleteCache(buildProductDetailCacheKey(productId));
}

/** Invalidates every cache affected by a Product.ratingStats change. */
async function invalidateProductRatingCaches(productId) {
  await invalidateProductDetailCache(productId);
  await deleteCacheByPrefix(PRODUCT_LIST_CACHE_PREFIX);
}

async function invalidateAdminDashboardCache() {
  await deleteCache(ADMIN_DASHBOARD_CACHE_KEY);
}

/**
 * Maps a Review document (or `.lean()` object, optionally with `userId`
 * populated with just `{ _id, name }`) to its public API shape. Never
 * exposes passwordHash — only `name` is ever selected on the populated
 * user, so there is nothing else to leak.
 */
function toPublicReview(doc) {
  const rawUser = doc.userId;
  const userIsPopulated = rawUser && typeof rawUser === 'object' && rawUser.name !== undefined;

  const user = userIsPopulated
    ? { id: rawUser._id.toString(), name: rawUser.name }
    : { id: rawUser.toString() };

  const rawProductId = doc.productId?._id ?? doc.productId;

  return {
    _id: doc._id.toString(),
    productId: rawProductId.toString(),
    user,
    rating: doc.rating,
    title: doc.title,
    body: doc.body,
    voteStats: doc.voteStats,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function isDuplicateReviewError(err) {
  return err?.code === 11000 || err?.cause?.code === 11000;
}

/**
 * average = (1*one + 2*two + 3*three + 4*four + 5*five) / count,
 * rounded to 2 decimal places. Always 0 when count is 0.
 */
function computeAverage(distribution, count) {
  if (!count || count <= 0) return 0;
  const weighted =
    1 * distribution.one + 2 * distribution.two + 3 * distribution.three + 4 * distribution.four + 5 * distribution.five;
  return Math.round((weighted / count) * 100) / 100;
}

async function fetchReviewForResponse(reviewId) {
  const populated = await Review.findById(reviewId).populate('userId', 'name').lean();
  return toPublicReview(populated);
}

/**
 * Lists a product's reviews newest-first using cursor pagination. Cached
 * by the exact (productId, limit, cursor) triple — a cache miss triggers
 * the real query and repopulates the cache. 404s if the product doesn't
 * exist (checked before touching the cache or the reviews collection).
 */
export async function listReviews(productId, query) {
  const productExists = await Product.exists({ _id: productId });
  if (!productExists) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const { limit, cursor } = parsePaginationParams(query);
  const cacheKey = buildReviewListCacheKey(productId, limit, query?.cursor);

  const cached = await getCache(cacheKey);
  recordCacheResult('review_list', Boolean(cached));
  if (cached) return cached;

  const filter = { productId: new mongoose.Types.ObjectId(productId), ...buildCursorFilter(cursor) };
  // Fetch one extra record so we can tell whether another page exists
  // without a separate count query.
  const records = await Review.find(filter)
    .sort(CURSOR_SORT)
    .limit(limit + 1)
    .populate('userId', 'name')
    .lean();

  const { items, pagination } = buildPaginationMeta(records, limit);
  const result = { items: items.map(toPublicReview), pagination };

  await setCache(cacheKey, result);
  return result;
}

/**
 * Creates a review for a product on behalf of `userId` (always derived
 * from `req.user`, never from client input), then atomically increments
 * Product.ratingStats inside the same transaction.
 */
export async function createReview(productId, userId, input) {
  const session = await mongoose.startSession();
  let created;

  try {
    session.startTransaction();

    const product = await Product.findById(productId).session(session);
    if (!product) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    }

    try {
      [created] = await Review.create(
        [{ productId, userId, rating: input.rating, title: input.title, body: input.body }],
        { session }
      );
    } catch (err) {
      if (isDuplicateReviewError(err)) {
        // Relies on the unique { productId, userId } index as the final
        // database-level guarantee against a duplicate review.
        throw new ApiError(409, 'REVIEW_ALREADY_EXISTS', 'You have already reviewed this product.');
      }
      throw err;
    }

    const bucketKey = RATING_BUCKET_KEYS[input.rating];
    const distribution = product.ratingStats.distribution;
    const newCount = product.ratingStats.count + 1;
    const newBucketValue = distribution[bucketKey] + 1;
    const newDistribution = {
      one: distribution.one,
      two: distribution.two,
      three: distribution.three,
      four: distribution.four,
      five: distribution.five,
      [bucketKey]: newBucketValue,
    };
    const newAverage = computeAverage(newDistribution, newCount);

    await Product.updateOne(
      { _id: productId },
      {
        $set: {
          'ratingStats.count': newCount,
          'ratingStats.average': newAverage,
          [`ratingStats.distribution.${bucketKey}`]: newBucketValue,
        },
      },
      { session }
    );

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }

  await invalidateReviewListCache(productId);
  await invalidateProductRatingCaches(productId);
  // Review count/recent-reviews changed regardless of the rating math above.
  await invalidateAdminDashboardCache();

  return fetchReviewForResponse(created._id);
}

/**
 * Updates a review's rating/title/body. Ownership must already be known
 * to belong to `userId` by the time the DB is touched — this function
 * re-derives and enforces it itself (never trusts a caller-supplied
 * owner). If `rating` changes, the old/new distribution buckets and the
 * average are updated atomically in the same transaction; count is left
 * untouched. If `rating` is unchanged, Product.ratingStats is not
 * touched at all.
 */
export async function updateReview(reviewId, userId, input) {
  const session = await mongoose.startSession();
  let updated;
  let ratingChanged = false;
  let productId;

  try {
    session.startTransaction();

    const review = await Review.findById(reviewId).session(session);
    if (!review) {
      throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
    }
    if (review.userId.toString() !== String(userId)) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only update your own review.');
    }

    productId = review.productId;
    const oldRating = review.rating;

    const fields = {};
    if (input.rating !== undefined) fields.rating = input.rating;
    if (input.title !== undefined) fields.title = input.title;
    if (input.body !== undefined) fields.body = input.body;

    updated = await Review.findOneAndUpdate({ _id: reviewId }, { $set: fields }, { new: true, runValidators: true }).session(
      session
    );

    ratingChanged = input.rating !== undefined && input.rating !== oldRating;

    if (ratingChanged) {
      const product = await Product.findById(productId).session(session);
      if (product) {
        const oldBucketKey = RATING_BUCKET_KEYS[oldRating];
        const newBucketKey = RATING_BUCKET_KEYS[input.rating];
        const distribution = product.ratingStats.distribution;

        const newOldBucketValue = Math.max(0, distribution[oldBucketKey] - 1);
        const newNewBucketValue = distribution[newBucketKey] + 1;

        const newDistribution = {
          one: distribution.one,
          two: distribution.two,
          three: distribution.three,
          four: distribution.four,
          five: distribution.five,
          [oldBucketKey]: newOldBucketValue,
          [newBucketKey]: newNewBucketValue,
        };
        // count is unchanged on an update.
        const newAverage = computeAverage(newDistribution, product.ratingStats.count);

        await Product.updateOne(
          { _id: productId },
          {
            $set: {
              [`ratingStats.distribution.${oldBucketKey}`]: newOldBucketValue,
              [`ratingStats.distribution.${newBucketKey}`]: newNewBucketValue,
              'ratingStats.average': newAverage,
            },
          },
          { session }
        );
      }
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }

  // Review content changed either way, so the list cache is always stale.
  await invalidateReviewListCache(productId);
  // Product detail + product list only need invalidating when ratingStats
  // actually changed.
  if (ratingChanged) {
    await invalidateProductRatingCaches(productId);
  }
  // The dashboard's "recent reviews" can include this review's content
  // even when the rating itself didn't change, so always invalidate.
  await invalidateAdminDashboardCache();

  return fetchReviewForResponse(updated._id);
}

/**
 * Deletes a review owned by `userId`, then atomically decrements
 * Product.ratingStats in the same transaction. Counts/buckets are
 * clamped at 0 and the average returns to 0 once count reaches 0.
 * If the parent product no longer exists (e.g. deleted independently),
 * the review is still removed but there is nothing to decrement.
 */
export async function deleteReview(reviewId, userId) {
  const session = await mongoose.startSession();
  let productId;

  try {
    session.startTransaction();

    const review = await Review.findById(reviewId).session(session);
    if (!review) {
      throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
    }
    if (review.userId.toString() !== String(userId)) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only delete your own review.');
    }

    productId = review.productId;

    await Review.deleteOne({ _id: reviewId }).session(session);

    const product = await Product.findById(productId).session(session);
    if (product) {
      const bucketKey = RATING_BUCKET_KEYS[review.rating];
      const distribution = product.ratingStats.distribution;

      const newBucketValue = Math.max(0, distribution[bucketKey] - 1);
      const newCount = Math.max(0, product.ratingStats.count - 1);

      const newDistribution = {
        one: distribution.one,
        two: distribution.two,
        three: distribution.three,
        four: distribution.four,
        five: distribution.five,
        [bucketKey]: newBucketValue,
      };
      const newAverage = computeAverage(newDistribution, newCount);

      await Product.updateOne(
        { _id: productId },
        {
          $set: {
            [`ratingStats.distribution.${bucketKey}`]: newBucketValue,
            'ratingStats.count': newCount,
            'ratingStats.average': newAverage,
          },
        },
        { session }
      );
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }

  await invalidateReviewListCache(productId);
  await invalidateProductRatingCaches(productId);
  await invalidateAdminDashboardCache();
}

/**
 * Administratively deletes a review regardless of owner (for moderation).
 * Atomically decrements Product.ratingStats in the same transaction
 * and invalidates all affected caches.
 */
export async function deleteReviewByAdmin(reviewId) {
  const session = await mongoose.startSession();
  let productId;
  let deletedReview;

  try {
    session.startTransaction();

    const review = await Review.findById(reviewId).session(session);
    if (!review) {
      // Review may have already been deleted
      await session.abortTransaction();
      return null;
    }

    deletedReview = review;
    productId = review.productId;

    await Review.deleteOne({ _id: reviewId }).session(session);

    const product = await Product.findById(productId).session(session);
    if (product) {
      const bucketKey = RATING_BUCKET_KEYS[review.rating];
      const distribution = product.ratingStats.distribution;

      const newBucketValue = Math.max(0, distribution[bucketKey] - 1);
      const newCount = Math.max(0, product.ratingStats.count - 1);

      const newDistribution = {
        one: distribution.one,
        two: distribution.two,
        three: distribution.three,
        four: distribution.four,
        five: distribution.five,
        [bucketKey]: newBucketValue,
      };
      const newAverage = computeAverage(newDistribution, newCount);

      await Product.updateOne(
        { _id: productId },
        {
          $set: {
            [`ratingStats.distribution.${bucketKey}`]: newBucketValue,
            'ratingStats.count': newCount,
            'ratingStats.average': newAverage,
          },
        },
        { session }
      );
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }

  if (productId) {
    await invalidateReviewListCache(productId);
    await invalidateProductRatingCaches(productId);
    await invalidateAdminDashboardCache();
  }

  return deletedReview;
}

export default { listReviews, createReview, updateReview, deleteReview, deleteReviewByAdmin };
