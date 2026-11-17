// The Markdown twin of every page outside the docs that is built from data: `/pricing/` →
// `/pricing.md`, `/use-cases/car-rental/` → `/use-cases/car-rental.md`. public/_headers names the
// HTML page as each twin's canonical. The blog's twins are in src/pages/blog/.
import type { APIRoute, GetStaticPaths } from 'astro';
import { MARKETING_PAGES } from '../data/pages';
import { type MarketingPage, markdownPath, pageMarkdown } from '../lib/page';

export const getStaticPaths = (() =>
  MARKETING_PAGES.map((page) => ({
    params: { twin: markdownPath(page.path).slice(1, -'.md'.length) },
    props: { page },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: MarketingPage }> = ({ props }) =>
  new Response(pageMarkdown(props.page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
