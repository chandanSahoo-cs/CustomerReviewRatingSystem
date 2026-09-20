import Product from './product.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { getCache, setCache, deleteCache, deleteCacheByPrefix } from '../../services/cache.service.js';
import { CURSOR_SORT, parsePaginationParams, buildCursorFilter, buildPaginationMeta } from '../../utils/pagination.js';
import { recordCacheResult } from '../../monitoring/metrics.js';

const LIST_CACHE_PREFIX = 'products:list:';
const DETAIL_CACHE_PREFIX = 'products:detail:';
// Matches the key the Admin module caches its dashboard under. Kept as a
// small local constant (rather than importing from the Admin module) so
// the two feature modules stay loosely coupled — this is the minimal
// hook needed so product mutations don't leave a stale dashboard cached.
const ADMIN_DASHBOARD_CACHE_KEY = 'admin:dashboard';

// Fields a client may ever set on a product. ratingStats is intentionally
// excluded here (and rejected earlier by the .strict() Zod schemas) — it
// is only ever mutated by the reviews module.
const WRITABLE_FIELDS = ['name', 'slug', 'description', 'category', 'price', 'image'];

function buildListCacheKey(limit, rawCursor) {
  return `${LIST_CACHE_PREFIX}limit=${limit}:cursor=${rawCursor || 'none'}`;
}

function buildDetailCacheKey(productId) {
  return `${DETAIL_CACHE_PREFIX}${productId}`;
}

/** Invalidates the caches affected by a product mutation. */
async function invalidateProductCaches(productId) {
  await deleteCacheByPrefix(LIST_CACHE_PREFIX);
  if (productId) {
    await deleteCache(buildDetailCacheKey(productId));
  }
  // Product create/update/delete all change dashboard totals/recents.
  await deleteCache(ADMIN_DASHBOARD_CACHE_KEY);
}

/** Maps a Product document (or `.lean()` object) to its public API shape. */
function toPublicProduct(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description,
    category: doc.category,
    price: doc.price,
    image: doc.image ?? null,
    ratingStats: doc.ratingStats,
    aiSummary: doc.aiInsights?.isGibberish ? null : (doc.aiInsights?.summary ?? null),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function pickWritableFields(input) {
  const fields = {};
  for (const key of WRITABLE_FIELDS) {
    if (input[key] !== undefined) {
      fields[key] = input[key];
    }
  }
  return fields;
}

function isDuplicateSlugError(err) {
  return err?.code === 11000 || err?.cause?.code === 11000;
}

/**
 * Lists products newest-first using cursor pagination. Cached by the
 * exact (limit, cursor) pair — a cache miss triggers the real query and
 * repopulates the cache.
 */
export async function listProducts(query) {
  const { limit, cursor } = parsePaginationParams(query);
  const cacheKey = buildListCacheKey(limit, query?.cursor);

  const cached = await getCache(cacheKey);
  recordCacheResult('product_list', Boolean(cached));
  if (cached) return cached;

  const filter = buildCursorFilter(cursor);
  // Fetch one extra record so we can tell whether another page exists
  // without a separate count query.
  const records = await Product.find(filter).sort(CURSOR_SORT).limit(limit + 1).lean();

  const { items, pagination } = buildPaginationMeta(records, limit);
  const result = { items: items.map(toPublicProduct), pagination };

  await setCache(cacheKey, result);
  return result;
}

export async function getProductById(productId) {
  const cacheKey = buildDetailCacheKey(productId);

  const cached = await getCache(cacheKey);
  recordCacheResult('product_detail', Boolean(cached));
  if (cached) return cached;

  const product = await Product.findById(productId).lean();
  if (!product) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const result = toPublicProduct(product);
  await setCache(cacheKey, result);
  return result;
}

export async function createProduct(input) {
  const fields = pickWritableFields(input);

  const existing = await Product.findOne({ slug: fields.slug }).lean();
  if (existing) {
    throw new ApiError(409, 'SLUG_ALREADY_EXISTS', 'A product with this slug already exists.');
  }

  let product;
  try {
    // ratingStats is never set here — the model's own defaults apply.
    product = await Product.create(fields);
  } catch (err) {
    if (isDuplicateSlugError(err)) {
      // Race: another request created the same slug between our check and insert.
      throw new ApiError(409, 'SLUG_ALREADY_EXISTS', 'A product with this slug already exists.');
    }
    throw err;
  }

  await invalidateProductCaches();
  return toPublicProduct(product);
}

export async function updateProduct(productId, input) {
  const fields = pickWritableFields(input);

  if (fields.slug) {
    const existing = await Product.findOne({ slug: fields.slug, _id: { $ne: productId } }).lean();
    if (existing) {
      throw new ApiError(409, 'SLUG_ALREADY_EXISTS', 'A product with this slug already exists.');
    }
  }

  let product;
  try {
    product = await Product.findByIdAndUpdate(
      productId,
      { $set: fields },
      { new: true, runValidators: true }
    );
  } catch (err) {
    if (isDuplicateSlugError(err)) {
      throw new ApiError(409, 'SLUG_ALREADY_EXISTS', 'A product with this slug already exists.');
    }
    throw err;
  }

  if (!product) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  await invalidateProductCaches(productId);
  return toPublicProduct(product);
}

export async function deleteProduct(productId) {
  const product = await Product.findByIdAndDelete(productId);
  if (!product) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  await invalidateProductCaches(productId);
}

export default { listProducts, getProductById, createProduct, updateProduct, deleteProduct };
