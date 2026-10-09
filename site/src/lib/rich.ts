/** Split copy on `backticks` so names of functions, tools and codes render as <code>. */
export function segments(text: string): { text: string; code: boolean }[] {
  return text.split('`').map((part, index) => ({ text: part, code: index % 2 === 1 }));
}
