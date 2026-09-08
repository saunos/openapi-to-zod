import type { IJsonSchema, OpenAPI } from '@scalar/openapi-types';

/** Severity level for a diagnostic message. */
export type DiagnosticLevel = 'error' | 'warning';

/**
 * A single diagnostic message produced during code generation.
 * Diagnostics report issues encountered while processing the OpenAPI spec.
 */
export type GeneratorDiagnostic = {
  /** Machine-readable diagnostic code (e.g. `"invalid-ref"`, `"missing-parameter-schema"`). */
  code: string;
  /** Human-readable description of the issue. */
  message: string;
  /** JSON Pointer (RFC 6901) to the problematic location in the OpenAPI document. */
  pointer: string;
  /** Severity of the diagnostic. */
  level: DiagnosticLevel;
};

/** Options controlling the behaviour of {@link generateZodSourceFromOpenApi}. */
export type GenerateZodSourceOptions = {
  /**
   * When `true`, the generator throws on the first error-level diagnostic
   * instead of collecting it. Defaults to `true`.
   */
  strict?: boolean;
  /**
   * When `true`, emits `z.codec(...)` for `date` and `date-time` string formats,
   * converting between ISO strings and `Date` objects. Defaults to `false`.
   */
  useDateCodecs?: boolean;
  /**
   * A map from JSON Pointer to a raw Zod expression string that replaces
   * the auto-generated schema at that location.
   *
   * Keys are JSON Pointers (RFC 6901) relative to the root of the OpenAPI
   * document, matching the `pointer` values used internally by the converter.
   *
   * Common pointer patterns:
   *
   * **Schema-level** (replaces a single schema node):
   * - Component schema:     `#/components/schemas/MyModel`
   * - Object property:      `#/components/schemas/MyModel/properties/myField`
   * - Path parameter:       `#/paths/~1pets/get/parameters/petId/schema`
   * - Query parameter:      `#/paths/~1pets/get/parameters/limit/schema`
   * - Response schema:      `#/paths/~1pets/get/responses/200/content/schema`
   *
   * **Group-level** (replaces an entire parameter/response group with a single expression):
   * - All path params:      `#/paths/~1pets/get/pathParams`
   * - All query params:     `#/paths/~1pets/get/queryParams`
   * - All request bodies:   `#/paths/~1pets/post/requestBody`
   * - All responses:        `#/paths/~1pets/get/responses`
   *
   * @example
   * ```ts
   * overrides: {
   *   '#/components/schemas/Date': 'z.coerce.date()',
   *   '#/components/schemas/User/properties/email': 'z.email().transform(v => v.toLowerCase())',
   *   '#/paths/~1pets/get/queryParams': 'petsQuerySchema',
   * }
   * ```
   */
  overrides?: Record<string, string>;
  /**
   * A callback invoked for every schema node during conversion.
   *
   * Called **after** the auto-generated Zod expression has been produced,
   * so the callback can inspect (or augment) the generated result.
   *
   * Return a `string` to replace the generated expression, or `undefined`
   * to keep the default.
   *
   * @example
   * ```ts
   * overrideCallback({ pointer, schema, kind, type, generatedExpression }) {
   *   // Coerce all date strings
   *   if (type === 'string' && schema.format === 'date-time') {
   *     return 'z.coerce.date()';
   *   }
   *   // Append .brand() to a specific schema
   *   if (pointer === '#/components/schemas/UserId') {
   *     return `${generatedExpression}.brand<'UserId'>()`;
   *   }
   *   // Replace all query params for a specific operation
   *   if (kind === 'query-params' && pointer.includes('~1pets')) {
   *     return 'petsQuerySchema';
   *   }
   * }
   * ```
   */
  overrideCallback?: (context: SchemaOverrideContext) => string | undefined;
  /**
   * When `false`, objects with `additionalProperties: false` will **not** have
   * `.strict()` appended to their Zod expression. Defaults to `true`.
   *
   * Set this to `false` when consuming the generated schemas at runtime and you
   * do not want Zod to reject extra keys (e.g. when the API may return
   * undocumented fields).
   */
  strictAdditionalProperties?: boolean;
  /**
   * When `true`, sorts object property keys and enum values alphabetically in
   * the generated Zod expressions. Defaults to `false` (input order is
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
   * When `true`, the generated code imports from `"zod/mini"` and uses the
   * tree-shakable functional API (`.check()`, `z.optional()`, `z.nullable()`,
   * etc.) instead of the standard Zod method chains.
   * Defaults to `false`.
   */
  useZodMini?: boolean;
  /**
   * When `true`, string `enum`s are emitted as open-ended unions that still
   * accept unknown values at runtime while keeping the known literals for
   * editor autocomplete:
   *
   * ```ts
   * z.union([z.enum(["pending", "failed"]), z.string() as unknown as z.ZodType<string & {}>])
   * // inferred type: "pending" | "failed" | (string & {})
   * ```
   *
   * Useful for APIs that may add new enum members without a spec update.
   * Non-string enums are unaffected. Defaults to `false`.
   */
  openEndedEnums?: boolean;
};

/**
 * Context passed to {@link GenerateZodSourceOptions.overrideCallback}
 * for every schema node encountered during conversion.
 */
export type SchemaOverrideContext = {
  /** JSON Pointer (RFC 6901) to this schema node in the OpenAPI document. */
  pointer: string;
  /** The raw JSON Schema value(s) being converted. For group-level overrides this is the full parameter/response map. */
  schema: unknown;
  /**
   * What kind of node this override is for.
   *
   * - `"schema"` - a single JSON Schema node (property, parameter, etc.).
   * - `"path-params"` - the entire path parameters group for an operation.
   * - `"query-params"` - the entire query parameters group for an operation.
   * - `"request-body"` - the entire request body group for an operation.
   * - `"responses"` - the entire responses group for an operation.
   */
  kind: 'schema' | 'path-params' | 'query-params' | 'request-body' | 'responses';
  /**
   * The resolved JSON Schema type (`"string"`, `"number"`, `"object"`, etc.).
   * Only set when `kind` is `"schema"`. `undefined` for group-level contexts
   * or when the type cannot be determined (e.g. `$ref`, `anyOf`, `const`, `enum`).
   */
  type: string | undefined;
  /** The Zod expression string that the converter auto-generated. */
  generatedExpression: string;
};

/** Options controlling the behaviour of {@link generateZodSourceFromJsonSchema}. */
export type GenerateJsonSchemaZodSourceOptions = {
  /**
   * When `true`, the generator throws on the first error-level diagnostic
   * instead of collecting it. Defaults to `true`.
   */
  strict?: boolean;
  /**
   * When `true`, emits `z.codec(...)` for `date` and `date-time` string formats,
   * converting between ISO strings and `Date` objects. Defaults to `false`.
   */
  useDateCodecs?: boolean;
  /**
   * A map from JSON Pointer to a raw Zod expression string that replaces
   * the auto-generated schema at that location.
   *
   * Pointer patterns:
   * - Root schema:  `#`
   * - Named def:    `#/$defs/MyModel`
   * - Property:     `#/$defs/MyModel/properties/myField`
   */
  overrides?: Record<string, string>;
  /**
   * When `false`, objects with `additionalProperties: false` will **not** have
   * `.strict()` appended. Defaults to `true`.
   */
  strictAdditionalProperties?: boolean;
  /**
   * When `true`, sorts object property keys and enum values alphabetically.
   * Defaults to `false`.
   */
  alphabetical?: boolean;
  /**
   * When `true`, non-required object properties that define a JSON Schema
   * `default` are emitted as `.default(value)` instead of `.optional()`.
   * Defaults to `true`.
   */
  defaultNonNullable?: boolean;
  /**
   * When `true`, the generated code imports from `"zod/mini"` and uses the
   * tree-shakable functional API (`.check()`, `z.optional()`, `z.nullable()`,
   * etc.) instead of the standard Zod method chains.
   * Defaults to `false`.
   */
  useZodMini?: boolean;
  /**
   * When `true`, string `enum`s are emitted as open-ended unions that still
   * accept unknown values at runtime while keeping the known literals for
   * editor autocomplete. Non-string enums are unaffected. Defaults to `false`.
   */
  openEndedEnums?: boolean;
};

/** The result returned by {@link generateZodSourceFromJsonSchema}. */
export type GenerateJsonSchemaZodSourceResult = {
  /** Generated TypeScript source code containing Zod schemas. */
  code: string;
  /** Diagnostics accumulated during generation. */
  diagnostics: GeneratorDiagnostic[];
};

/** The result returned by {@link generateZodSourceFromOpenApi}. */
export type GenerateZodSourceResult = {
  /** Generated TypeScript source code containing Zod schemas. */
  code: string;
  /** Diagnostics accumulated during generation. */
  diagnostics: GeneratorDiagnostic[];
};

/** An OpenAPI 3.x document. */
export type OpenApiObject = OpenAPI.Document;

/** Generic plain object used where a concrete shape is not yet known. */
export type PlainObject = Record<string, unknown>;

/**
 * An OpenAPI Media Type Object, narrowed to the fields the generator reads.
 * Additional spec fields (`example`, `encoding`, ...) are permitted.
 */
export type MediaTypeObject = {
  /** The schema describing this media type's payload. */
  schema?: IJsonSchema;
} & PlainObject;

/** A map from media type string (e.g. `"application/json"`) to its definition. */
export type ContentObject = Record<string, MediaTypeObject | undefined>;

/**
 * A validated OpenAPI Parameter Object.
 *
 * Both `schema` and `content` are optional here — the spec allows exactly one,
 * but the generator inspects whichever is present rather than branching on a
 * discriminated union.
 */
export type ParameterObject = {
  /** The parameter name. */
  name: string;
  /** The parameter location. */
  in: 'query' | 'header' | 'path' | 'cookie';
  /** Whether the parameter is mandatory. */
  required?: boolean;
  /** The schema defining the parameter's type. */
  schema?: IJsonSchema;
  /** Media-type map used instead of `schema` for complex parameters. */
  content?: ContentObject;
} & PlainObject;

/** A validated OpenAPI Request Body Object. */
export type RequestBodyObject = {
  /** Whether the request body is required. */
  required?: boolean;
  /** The request body payloads keyed by media type. */
  content: ContentObject;
} & PlainObject;

/** A validated OpenAPI Response Object. */
export type ResponseObject = {
  /** A description of the response. */
  description: string;
  /** The response payloads keyed by media type. */
  content?: ContentObject;
} & PlainObject;

/** A validated OpenAPI Path Item Object. */
export type PathItemObject = {
  /** Parameters applicable to every operation under this path. */
  parameters?: unknown[];
} & PlainObject;

/**
 * Intermediate representation of a single API operation extracted from an
 * OpenAPI path item. Each field maps parameter/body/response names to their
 * raw JSON Schema objects.
 */
export type ExtractedPathOperation = {
  /** Path parameter schemas keyed by parameter name. */
  path: Record<string, PlainObject>;
  /** Query parameter schemas keyed by parameter name. */
  query: Record<string, PlainObject>;
  /** Request body schemas keyed by media type (e.g. `"application/json"`). */
  requestBody?: Record<string, PlainObject>;
  /** Response schemas keyed by HTTP status code (e.g. `"200"`, `"default"`). */
  responses: Record<string, PlainObject>;
};

/**
 * The full intermediate model extracted from an OpenAPI document.
 * This is the data structure that the emitter turns into Zod source code.
 */
export type ExtractedModel = {
  /** Operations keyed by `path -> HTTP method`. */
  paths: Record<string, Record<string, ExtractedPathOperation>>;
  /** Reusable component schemas from `#/components/schemas`. */
  components: {
    schemas: Record<string, PlainObject>;
  };
};
