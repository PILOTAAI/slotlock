// Types for scripts/schema-functions.mjs, which the tests import.
export declare const RELEASED_SCHEMA_FUNCTIONS: string;
export declare function isSchemaSource(path: string): boolean;
export declare function schemaFunctionNames(text: string): Set<string>;
export declare function releasedFunctions(root: string, ref?: string | null): string[];
