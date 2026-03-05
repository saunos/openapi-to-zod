/**
 * Public API surface for the `openapi-zod` package.
 *
 * Re-exports the generator function and the configuration / result types.
 *
 * @module openapi-zod
 */

export { generateZodSourceFromOpenApi } from './generator';
export { convertJsonSchemaToZod } from './json-schema-to-zod';
export type {
  ConvertJsonSchemaToZodOptions,
  ConvertJsonSchemaToZodResult,
} from './json-schema-to-zod';
export type {
  GenerateZodSourceOptions,
  GenerateZodSourceResult,
  GeneratorDiagnostic,
  DiagnosticLevel,
  OpenApiObject,
  SchemaOverrideContext,
} from './types';
