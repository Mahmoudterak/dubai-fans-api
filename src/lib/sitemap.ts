/**
 * Sitemap state module — holds the cached XML string and exposes
 * rebuildSitemap() so any route or webhook can trigger a fresh build
 * without a server restart.
 *
 * Blog posts are sourced from the database (blog_posts table).
 * The initial build at startup uses a synchronous snapshot; subsequent
 * rebuilds via rebuildSitemap() are async and update the cache in-place.
 */
import { db } from "@workspace/db";
import { blogPosts } from "@workspace/db/schema";
import { logger } from "./logger.js";

const BASE = "https://mtuaefans.com";

/** XML-escape a string so arbitrary slugs or dates cannot break the XML. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function u(
  loc: string,
  lastmod: string,
  changefreq: string,
  priority: string,
): string {
  return (
    `  <url>` +
    `<loc>${xmlEscape(`${BASE}${loc}`)}</loc>` +
    `<lastmod>${xmlEscape(lastmod)}</lastmod>` +
    `<changefreq>${changefreq}</changefreq>` +
    `<priority>${priority}</priority>` +
    `</url>`
  );
}

export function buildSitemapFromPosts(
  posts: { id: string; dateISO: string }[],
): string {
  const today = new Date().toISOString().slice(0, 10);

  const staticUrls = [
    u("/", today, "weekly", "1.0"),
    u("/services", today, "monthly", "0.9"),
    u("/website-templates", today, "monthly", "0.8"),
    u("/about", today, "monthly", "0.8"),
    u("/projects", today, "monthly", "0.8"),
    u("/store", today, "weekly", "0.8"),
    u("/blog", today, "weekly", "0.8"),
  ];

  const blogUrls = posts.map((post) =>
    u(`/blog/${post.id}`, post.dateISO, "monthly", "0.7"),
  );

  const serviceDetailUrls = [
    u("/services/meta-ads-dubai",          today, "monthly", "0.85"),
    u("/services/google-ads-uae",          today, "monthly", "0.85"),
    u("/services/seo-dubai",               today, "monthly", "0.85"),
    u("/services/social-media-management", today, "monthly", "0.85"),
    u("/services/website-design-dubai",    today, "monthly", "0.85"),
    u("/services/tiktok-ads-uae",          today, "monthly", "0.85"),
    u("/services/snapchat-ads-dubai",      today, "monthly", "0.85"),
    u("/services/linkedin-ads-uae",        today, "monthly", "0.85"),
  ];

  const toolUrls = [
    u("/tools", today, "monthly", "0.7"),
    u("/analyze", today, "monthly", "0.7"),
  ];

  const legalUrls = [
    u("/privacy", "2026-01-01", "yearly", "0.4"),
    u("/campaign-policy", "2026-01-01", "yearly", "0.4"),
    u("/refund-policy", "2026-01-01", "yearly", "0.4"),
  ];

  const all = [...staticUrls, ...serviceDetailUrls, ...blogUrls, ...toolUrls, ...legalUrls];

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    all.join("\n") +
    `\n</urlset>`
  );
}

// ── In-process cache ──────────────────────────────────────────────────────────
// Starts empty; populated asynchronously on first server start via initSitemap()
let _sitemapXml = buildSitemapFromPosts([]);

/** Return the current cached sitemap XML. */
export function getSitemapXml(): string {
  return _sitemapXml;
}

/**
 * Rebuild the sitemap by fetching current posts from the database,
 * then update the in-process cache. Called by:
 *  - POST /api/sitemap/rebuild webhook
 *  - POST /api/blog/posts after a new article is created
 *  - initSitemap() on server startup
 */
export async function rebuildSitemap(): Promise<string> {
  try {
    const posts = await db
      .select({ id: blogPosts.id, dateISO: blogPosts.dateISO })
      .from(blogPosts);
    _sitemapXml = buildSitemapFromPosts(posts);
    logger.info({ postCount: posts.length }, "Sitemap rebuilt from database");
  } catch (err) {
    logger.error({ err }, "Failed to rebuild sitemap from database");
  }
  return _sitemapXml;
}

/** Call once on server startup to populate the sitemap cache from the DB. */
export async function initSitemap(): Promise<void> {
  await rebuildSitemap();
}
