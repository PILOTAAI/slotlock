// Types for scripts/cms-scheduled-merge.mjs, which the tests import.
export declare function cmsPathAllowed(path: string): boolean;
export declare function scheduleOf(bodies: readonly string[]): { sha: string; at: string; by: string } | null;
export declare function mergeDuePosts(options: {
  appId: string;
  installationId: string;
  privateKey: string;
  repository: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<{ number: number; slug: string; outcome: string }[]>;
