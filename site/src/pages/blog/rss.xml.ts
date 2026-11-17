// The blog's RSS 2.0 feed: /blog/rss.xml.
import type { APIRoute } from 'astro';
import { rss } from '../../lib/blog';

export const GET: APIRoute = () =>
  new Response(rss(), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
