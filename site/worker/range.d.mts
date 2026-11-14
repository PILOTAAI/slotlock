/** One byte range of a file of `size` bytes: [first, last], 'none' when it cannot be met, or null for the whole file. */
export function byteRange(header: string | null | undefined, size: number): [number, number] | 'none' | null;
declare const worker: {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response>;
};
export default worker;
