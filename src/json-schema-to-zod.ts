/**
 * Standalone JSON Schema → Zod expression converter.
 *
 * Unlike {@link generateZodSourceFromOpenApi}, this function works on a single
 * JSON Schema value without requiring a full OpenAPI document.  `$ref`s that
 * point at `#/components/schemas/*` are **not** resolved — use the full
 * generator for schemas with cross-references.
 *
 * @module json-schema-to-zod
 */

import { DiagnosticCollector } from './diagnostics-collector';
import { SchemaToZodConverter } from './schema-to-zod-converter';
import type { GeneratorDiagnostic, OpenApiObject } from './types';

/** Options for {@link convertJsonSchemaToZod}. */
export type ConvertJsonSchemaToZodOptions = {
  /**
   * When `true`, throws on the first error-level diagnostic instead of
   * collecting it. Defaults to `false`.
   */
  strict?: boolean;
  /**
   * When `true`, emits `z.codec(...)` for `date` and `date-time` string formats,
   * converting between ISO strings and `Date` objects. Defaults to `false`.
   */
  useDateCodecs?: boolean;
  /**
   * When `false`, objects with `additionalProperties: false` will **not** have
   * `.strict()` appended. Defaults to `true`.
   */
  strictAdditionalProperties?: boolean;
  /**
   * When `true`, sorts object property keys and enum values alphabetically in
   * the generated Zod expression. Defaults to `false` (input order is
   * preserved).
   */
  alphabetical?: boolean;
  /**
   * When `true`, non-required object properties that define a JSON Schema
   * `default` are emitted as `.default(value)` instead of `.optional()`.
   * Defaults to `true`.
   */
  defaultNonNullable?: boolean;
  /**
   * When `true`, string `enum`s are emitted as open-ended unions that still
   * accept unknown values at runtime while keeping the known literals for
   * editor autocomplete. Non-string enums are unaffected. Defaults to `false`.
   */
  openEndedEnums?: boolean;
  /**
   * When `true`, plain string schemas (no `format`) trim leading and trailing
   * whitespace before length and pattern checks: `z.string().trim().min(1)`.
   * Format schemas such as `z.email()` or `z.uuid()` are unaffected.
   * Defaults to `false`.
   */
  trimStrings?: boolean;
};

/** Result returned by {@link convertJsonSchemaToZod}. */
export type ConvertJsonSchemaToZodResult = {
  /** The generated Zod expression string (e.g. `"z.object({ id: z.uuid() })"`) */
  expression: string;
  /** Any warnings or errors encountered during conversion. */
  diagnostics: GeneratorDiagnostic[];
};

/**
 * Converts a single JSON Schema value into a Zod expression string.
 *
 * The returned `expression` is valid TypeScript that evaluates to a
 * `z.ZodType` and can be used directly in generated code or `eval`'d at
 * runtime.
 *
 * @param schema - A JSON Schema value (object, boolean, etc.).
 * @param options - Conversion options.
 * @returns The Zod expression and any diagnostics.
 *
 * @example
 * ```ts
 * import { convertJsonSchemaToZod } from '@saunos/openapi-to-zod';
 *
 * const { expression } = convertJsonSchemaToZod({
 *   type: 'object',
 *   required: ['id', 'name'],
 *   properties: {
 *     id:   { type: 'string', format: 'uuid' },
 *     name: { type: 'string' },
 *     age:  { type: 'integer', minimum: 0 },
 *   },
 * });
 *
 * console.log(expression);
 * // z.object({ age: z.int().min(0).optional(), id: z.uuid(), name: z.string() })
 * ```
 */
export function convertJsonSchemaToZod(
  schema: unknown,
  options: ConvertJsonSchemaToZodOptions = {},
): ConvertJsonSchemaToZodResult {
  const diagnostics = new DiagnosticCollector(options.strict ?? false);

  // Provide a minimal stub OpenAPI root — no components, so $refs won't resolve.
  const stubRoot = {
    openapi: '3.1.0',
    info: { title: '', version: '' },
    paths: {},
  } as unknown as OpenApiObject;

  const converter = new SchemaToZodConverter(
    stubRoot,
    {},
    diagnostics,
    options.useDateCodecs ?? false,
    {},
    undefined,
    options.strictAdditionalProperties ?? true,
    options.alphabetical ?? false,
    options.defaultNonNullable ?? true,
    false,
    options.openEndedEnums ?? false,
    options.trimStrings ?? false,
  );

  const expression = converter.convert(schema, '#');

  return { expression, diagnostics: diagnostics.list() };
}
