// The blog's list of posts as Markdown: /blog.md.
import type { APIRoute } from 'astro';
import { blogMarkdown } from '../lib/blog';

export const GET: APIRoute = () =>
  new Response(blogMarkdown(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
