/**
 * Split copy on `backticks` so names of functions, tools and codes render as <code>, and the rest on
 * [text](/path) so a sentence can link to a page of this site. Only site paths are links: the build
 * checks each one (scripts/postbuild.mjs), and the Markdown twin keeps the same syntax.
 */
export function segments(text: string): { text: string; code: boolean; href?: string }[] {
  return text.split('`').flatMap((part, index) => {
    if (index % 2 === 1) return [{ text: part, code: true }];
    const out: { text: string; code: boolean; href?: string }[] = [];
    let last = 0;
    for (const link of part.matchAll(/\[([^\]]+)\]\((\/[^)\s]*)\)/g)) {
      if (link.index > last) out.push({ text: part.slice(last, link.index), code: false });
      out.push({ text: link[1] as string, code: false, href: link[2] as string });
      last = link.index + link[0].length;
    }
    if (last < part.length || out.length === 0) out.push({ text: part.slice(last), code: false });
    return out;
  });
}
