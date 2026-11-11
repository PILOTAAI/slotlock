// Each post as Markdown: /blog/<slug>.md. public/_headers names the HTML page as its canonical.
import type { APIRoute, GetStaticPaths } from 'astro';
import { type Post, POSTS } from '../../data/blog';
import { postMarkdown } from '../../lib/blog';

export const getStaticPaths = (() =>
  POSTS.map((post) => ({ params: { slug: post.slug }, props: { post } }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ post: Post }> = ({ props }) =>
  new Response(postMarkdown(props.post), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
