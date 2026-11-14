// Types for scripts/cms-scheduled-merge.mjs, which the tests import.
export declare function cmsPathAllowed(path: string): boolean;
export declare function cmsChangeAllowed(
  slug: string,
  files: readonly { path: string; previous: string | null; status: string; patch: string | null }[],
): boolean;
export declare function signOffsOf(
  commits: readonly { commit?: { message?: unknown; author?: { email?: unknown } | null } }[] | null | undefined,
): string[];
export declare function scheduleOf(bodies: readonly string[]): { sha: string; at: string; by: string } | null;
export declare function mergeDuePosts(options: {
  /** An installation token of the App, as cms-schedule.yml's token step gives it. */
  token: string;
  /** The App's slug, by which its own comments are known. */
  appSlug: string;
  repository: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<{ number: number; slug: string; outcome: string }[]>;
