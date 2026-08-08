import {
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * blog_posts — stores all blog articles.
 * The `id` column holds the human-readable slug (e.g. "best-seo-tools-2025")
 * so existing URLs remain stable after migration.
 */
export const blogPosts = pgTable("blog_posts", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  image: text("image").notNull().default(""),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  date: text("date").notNull(),       // human-readable Arabic date
  dateISO: text("date_iso").notNull(), // YYYY-MM-DD — used by sitemap + JSON-LD
  readTime: text("read_time").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertBlogPostSchema = createInsertSchema(blogPosts).omit({
  createdAt: true,
});

export type BlogPost = typeof blogPosts.$inferSelect;
export type InsertBlogPost = z.infer<typeof insertBlogPostSchema>;
