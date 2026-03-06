/**
 * Converts JSON Schema (as found in OpenAPI 3.x specs) into Zod expression
 * strings that can be emitted as TypeScript source code.
 *
 * @module schema-to-zod-converter
 */

import type { DiagnosticCollector } from './diagnostics-collector';
import type { OpenApiObject, SchemaOverrideContext } from './types';
import { SchemaObjectSchema } from '@scalar/openapi-types/schemas/3.1/unprocessed';

import type { IJsonSchema } from '@scalar/openapi-types';
import {
  escapeJsonPointer,
  inferType,
  isObject,
  resolveRef,
  sortKeys,
  toLiteral,
  toPropertyKey,
  unescapeJsonPointer,
} from './json-schema-utils';

/**
 * Transforms JSON Schema nodes into stringified Zod expressions.
 *
 * Handles `$ref` resolution (via `z.lazy` for component schemas), `const`,
 * `enum`, union types (`anyOf` / `oneOf`), intersections (`allOf`),
 * and all primitive + composite JSON Schema types.
 */
export class SchemaToZodConverter {
  /**
   * @param openApiObject - The root OpenAPI document (used for `$ref` resolution).
   * @param componentSchemaVarNames - Map from component schema name to the generated variable name.
   * @param diagnostics - Collector for any conversion issues.
   * @param useDateCodecs - When `true`, emit `z.codec(...)` for `date` and `date-time` formats.
   * @param overrides - Map from JSON Pointer to a custom Zod expression that replaces the generated one.
   * @param overrideCallback - Optional callback invoked for every schema node after generation.
   * @param strictAdditionalProperties - When `false`, suppress `.strict()` that would otherwise be
   *   emitted for objects with `additionalProperties: false`. Defaults to `true`.
   * @param alphabetical - When `true`, sort object property keys and enum values alphabetically.
   *   Defaults to `false`.
   */
  private readonly usedCodecs = new Set<'datetime' | 'date'>();

  constructor(
    private readonly openApiObject: OpenApiObject,
    private readonly componentSchemaVarNames: Record<string, string>,
    private readonly diagnostics: DiagnosticCollector,
    private readonly useDateCodecs: boolean = false,
    private readonly overrides: Record<string, string> = {},
    private readonly overrideCallback?:
      | ((context: SchemaOverrideContext) => string | undefined)
      | undefined,
    private readonly strictAdditionalProperties: boolean = true,
    private readonly alphabetical: boolean = false,
  ) {}

  /** Returns the set of date codec keys that were actually emitted during conversion. */
  getUsedCodecs(): ReadonlySet<'datetime' | 'date'> {
    return this.usedCodecs;
  }

  /**
   * Recursively converts a JSON Schema value into a Zod expression string.
   *
   * The produced string is valid TypeScript that evaluates to a `z.ZodType`.
   * Unknown or invalid schemas fall back to `z.unknown()`.
   *
   * @param schemaInput - Raw schema value (may be a `$ref`, primitive type, etc.).
   * @param pointer - JSON Pointer for diagnostic messages.
   * @returns A Zod expression string (e.g. `"z.email()"`).
   *
   * @example
   * ```ts
   * converter.convert({ type: 'string', format: 'email' }, '#/schema');
   * // => 'z.email()'
   *
   * converter.convert({ type: 'integer', minimum: 0 }, '#/schema');
   * // => 'z.int().min(0)'
   *
   * converter.convert({ enum: ['active', 'inactive'] }, '#/schema');
   * // => 'z.enum(["active", "inactive"])'
   * ```
   */
  convert(schemaInput: unknown, pointer: string): string {
    // Check for a user-supplied override at this exact pointer
    if (pointer in this.overrides) {
      return this.overrides[pointer]!;
    }

    const expr = this.convertInternal(schemaInput, pointer);

    // Give the callback a chance to replace or augment the expression
    if (this.overrideCallback) {
      const parsed = SchemaObjectSchema.safeParse(schemaInput);
      const schema: unknown = parsed.success ? parsed.data : schemaInput;
      const type = parsed.success
        ? typeof parsed.data.type === 'string'
          ? parsed.data.type
          : inferType(parsed.data)
        : undefined;

      const callbackResult = this.overrideCallback({
        pointer,
        schema,
        kind: 'schema',
        type,
        generatedExpression: expr,
      });
      if (typeof callbackResult === 'string') {
        return callbackResult;
      }
    }

    return expr;
  }

  /**
   * Internal conversion logic, separated so that {@link convert} can
   * intercept the result for the override callback.
   */
  private convertInternal(schemaInput: unknown, pointer: string): string {
    const result = SchemaObjectSchema.safeParse(schemaInput);

    if (!result.success) {
      this.diagnostics.push(
        'invalid-schema',
        `Schema validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`,
        pointer,
      );
      return 'z.unknown()';
    }

    const schema: IJsonSchema = result.data;

    if (typeof schema.$ref === 'string') {
      return this.refToExpression(schema.$ref, pointer);
    }

    if (schema.const !== undefined) {
      return `z.literal(${toLiteral(schema.const)})`;
    }

    if (Array.isArray(schema.enum)) {
      return this.enumToExpression(schema.enum, pointer);
    }

    if (Array.isArray(schema.type)) {
      const variantExpressions = schema.type.map((variantType, index) => {
        if (variantType === 'null') {
          return 'z.null()';
        }
        return this.convert({ ...schema, type: variantType }, `${pointer}/type/${index}`);
      });
      return unionExpressions(variantExpressions);
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      const variantExpressions = schema.anyOf.map((item, index) =>
        this.convert(item, `${pointer}/anyOf/${index}`),
      );
      return unionExpressions(variantExpressions);
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      const variantExpressions = schema.oneOf.map((item, index) =>
        this.convert(item, `${pointer}/oneOf/${index}`),
      );
      return unionExpressions(variantExpressions);
    }

    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
      const variantExpressions = schema.allOf.map((item, index) =>
        this.convert(item, `${pointer}/allOf/${index}`),
      );
      return intersectionExpressions(variantExpressions);
    }

    let expr: string;

    const type = typeof schema.type === 'string' ? schema.type : inferType(schema);
    switch (type) {
      case 'string': {
        const format = typeof schema.format === 'string' ? schema.format : undefined;
        // Zod 4: format validators are top-level schemas, not string methods
        if (format === 'uuid') {
          expr = 'z.uuid()';
        } else if (format === 'date-time') {
          if (this.useDateCodecs) {
            this.usedCodecs.add('datetime');
            expr = 'isoDatetimeToDate';
          } else {
            expr = 'z.iso.datetime()';
          }
        } else if (format === 'date') {
          if (this.useDateCodecs) {
            this.usedCodecs.add('date');
            expr = 'isoDateToDate';
          } else {
            expr = 'z.iso.date()';
          }
        } else if (format === 'email') {
          expr = 'z.email()';
        } else if (format === 'uri') {
          expr = 'z.url()';
        } else {
          expr = 'z.string()';
          // min/max/regex only apply to plain z.string(), not format schemas
          if (typeof schema.minLength === 'number') {
            expr += `.min(${schema.minLength})`;
          }
          if (typeof schema.maxLength === 'number') {
            expr += `.max(${schema.maxLength})`;
          }
          if (typeof schema.pattern === 'string') {
            expr += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
          }
        }
        break;
      }
      case 'number': {
        expr = 'z.number()';
        if (typeof schema.minimum === 'number') {
          expr += `.min(${schema.minimum})`;
        }
        if (typeof schema.maximum === 'number') {
          expr += `.max(${schema.maximum})`;
        }
        if (typeof schema.exclusiveMinimum === 'number') {
          expr += `.gt(${schema.exclusiveMinimum})`;
        }
        if (typeof schema.exclusiveMaximum === 'number') {
          expr += `.lt(${schema.exclusiveMaximum})`;
        }
        if (typeof schema.multipleOf === 'number') {
          expr += `.multipleOf(${schema.multipleOf})`;
        }
        break;
      }
      case 'integer': {
        // Zod 4: z.int() replaces z.number().int()
        expr = 'z.int()';
        if (typeof schema.minimum === 'number') {
          expr += `.min(${schema.minimum})`;
        }
        if (typeof schema.maximum === 'number') {
          expr += `.max(${schema.maximum})`;
        }
        if (typeof schema.exclusiveMinimum === 'number') {
          expr += `.gt(${schema.exclusiveMinimum})`;
        }
        if (typeof schema.exclusiveMaximum === 'number') {
          expr += `.lt(${schema.exclusiveMaximum})`;
        }
        break;
      }
      case 'boolean': {
        expr = 'z.boolean()';
        break;
      }
      case 'null': {
        expr = 'z.null()';
        break;
      }
      case 'array': {
        const itemSchema = schema.items ?? {};
        expr = `z.array(${this.convert(itemSchema, `${pointer}/items`)})`;
        if (typeof schema.minItems === 'number') {
          expr += `.min(${schema.minItems})`;
        }
        if (typeof schema.maxItems === 'number') {
          expr += `.max(${schema.maxItems})`;
        }
        break;
      }
      case 'object': {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const requiredList = Array.isArray(schema.required)
          ? new Set(schema.required.filter((value): value is string => typeof value === 'string'))
          : new Set<string>();
        const propertyKeys = this.alphabetical ? sortKeys(properties) : Object.keys(properties);
        const entries = propertyKeys.map((key) => {
          const childExpr = this.convert(
            properties[key],
            `${pointer}/properties/${escapeJsonPointer(key)}`,
          );
          const finalExpr = requiredList.has(key) ? childExpr : `${childExpr}.optional()`;
          return `  ${toPropertyKey(key)}: ${finalExpr},`;
        });

        if (entries.length === 0) {
          expr = 'z.object({})';
        } else {
          expr = `z.object({\n${entries.join('\n')}\n})`;
        }

        if (schema.additionalProperties === false && this.strictAdditionalProperties) {
          expr += '.strict()';
        } else if (isObject(schema.additionalProperties)) {
          expr += `.catchall(${this.convert(schema.additionalProperties, `${pointer}/additionalProperties`)})`;
        }
        break;
      }
      default: {
        expr = 'z.unknown()';
        break;
      }
    }

    if (schema.nullable === true) {
      expr += '.nullable()';
    }

    return expr;
  }

  /**
   * Converts a `$ref` string into the appropriate Zod expression.
   *
   * Component schema refs (`#/components/schemas/X`) are emitted as
   * `z.lazy(() => XSchema)` to support circular references. Other local
   * refs are resolved and recursively converted.
   *
   * @param ref - The `$ref` URI.
   * @param pointer - JSON Pointer for diagnostics.
   * @returns A Zod expression string.
   *
   * @example
   * ```ts
   * refToExpression('#/components/schemas/Pet', '#/paths/~1pets/get');
   * // => 'z.lazy(() => PetSchema)'
   * ```
   */
  // TODO: not necessary since we provide resolved refs?
  private refToExpression(ref: string, pointer: string): string {
    const schemaMatch = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
    if (schemaMatch) {
      const componentName = unescapeJsonPointer(schemaMatch[1] ?? '');
      const varName = this.componentSchemaVarNames[componentName];
      if (!varName) {
        this.diagnostics.push(
          'missing-component-schema',
          `Unknown component schema ref: ${ref}`,
          pointer,
        );
        return 'z.unknown()';
      }
      return `z.lazy(() => ${varName})`;
    }

    const resolved = resolveRef(ref, this.openApiObject, pointer, this.diagnostics);
    return this.convert(resolved, `${pointer}/$ref`);
  }

  /**
   * Converts a JSON Schema `enum` array into a Zod expression.
   *
   * When all values are strings, `z.enum([...])` is used; otherwise
   * each value becomes a `z.literal(...)` wrapped in a union.
   *
   * @param values - The enum values.
   * @param pointer - JSON Pointer for diagnostics.
   * @returns A Zod expression string.
   *
   * @example
   * ```ts
   * enumToExpression(['active', 'inactive'], '#/schema');
   * // => 'z.enum(["active", "inactive"])'
   *
   * enumToExpression([1, 2, 3], '#/schema');
   * // => 'z.union([z.literal(1), z.literal(2), z.literal(3)])'
   * ```
   */
  private enumToExpression(values: unknown[], pointer: string): string {
    if (values.length === 0) {
      this.diagnostics.push('empty-enum', 'Enum must contain at least one value', pointer);
      return 'z.never()';
    }

    const allStrings = values.every((value) => typeof value === 'string');
    if (allStrings) {
      const sorted = this.alphabetical
        ? [...values].sort((a, b) => String(a).localeCompare(String(b)))
        : values;
      const literals = sorted.map((value) => JSON.stringify(value as string)).join(', ');
      return `z.enum([${literals}])`;
    }

    const literalSchemas = this.alphabetical
      ? [...values]
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((value) => `z.literal(${toLiteral(value)})`)
      : values.map((value) => `z.literal(${toLiteral(value)})`);
    return unionExpressions(literalSchemas);
  }
}

/**
 * Wraps one or more Zod expressions in a `z.union([…])` call.
 *
 * Returns `z.never()` for an empty list and the single expression
 * directly when there is only one member.
 *
 * @param expressions - Individual Zod expression strings.
 * @returns A single Zod expression representing their union.
 *
 * @example
 * ```ts
 * unionExpressions([]);                              // => 'z.never()'
 * unionExpressions(['z.string()']);                   // => 'z.string()'
 * unionExpressions(['z.string()', 'z.number()']);     // => 'z.union([z.string(), z.number()])'
 * ```
 */
function unionExpressions(expressions: string[]): string {
  if (expressions.length === 0) {
    return 'z.never()';
  }
  if (expressions.length === 1) {
    return expressions[0] ?? 'z.never()';
  }
  return `z.union([${expressions.join(', ')}])`;
}

/**
 * Wraps one or more Zod expressions in nested `z.intersection(…)` calls.
 *
 * Returns `z.unknown()` for an empty list and the single expression
 * directly when there is only one member.
 *
 * @param expressions - Individual Zod expression strings.
 * @returns A single Zod expression representing their intersection.
 *
 * @example
 * ```ts
 * intersectionExpressions([]);                           // => 'z.unknown()'
 * intersectionExpressions(['z.object({})']);              // => 'z.object({})'
 * intersectionExpressions(['z.object({})', 'z.object({})']);
 * // => 'z.intersection(z.object({}), z.object({}))'
 * ```
 */
function intersectionExpressions(expressions: string[]): string {
  if (expressions.length === 0) {
    return 'z.unknown()';
  }
  if (expressions.length === 1) {
    return expressions[0] ?? 'z.unknown()';
  }
  return expressions
    .slice(1)
    .reduce((acc, item) => `z.intersection(${acc}, ${item})`, expressions[0] ?? 'z.unknown()');
}
