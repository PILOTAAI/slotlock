import type { APIRoute, GetStaticPaths } from 'astro';
import { type CollectionEntry, getCollection } from 'astro:content';
import { markdownTwinSlug } from '../../lib/markdown-twin';

/** A Markdown twin of every docs page: the page's own Markdown source under its title. */
export const getStaticPaths = (async () => {
  const docs = await getCollection('docs');
  return docs.flatMap((entry) => {
    const slug = markdownTwinSlug(entry.id);
    return slug ? [{ params: { slug }, props: { entry } }] : [];
  });
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: CollectionEntry<'docs'> }> = ({ props }) => {
  const { title, description } = props.entry.data;
  const parts = [`# ${title}`];
  if (description) parts.push(`> ${description}`);
  parts.push((props.entry.body ?? '').trim());
  return new Response(`${parts.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
