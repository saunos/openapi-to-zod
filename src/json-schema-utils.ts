/**
 * Utility helpers for working with JSON Schema and OpenAPI structures.
 *
 * Provides functions for JSON Pointer handling, `$ref` resolution,
 * schema normalisation, and safe object validation.
 *
 * @module json-schema-utils
 */

import type { IJsonSchema } from '@scalar/openapi-types';
import type {
  OpenApiObject,
  ResponseObject,
  ParameterObject,
  RequestBodyObject,
  PlainObject,
} from './types';
import type { DiagnosticCollector } from './diagnostics-collector';
import {
  ParameterObjectSchema,
  RequestBodyObjectSchema,
  ResponseObjectSchema,
} from '@scalar/openapi-types/schemas/3.1/processed';

/**
 * Infers the JSON Schema `type` keyword from structural cues when the
 * explicit `type` field is absent.
 *
 * @param schema - The JSON Schema to inspect.
 * @returns `"object"` if `properties` or `additionalProperties` exist,
 *          `"array"` if `items` exists, otherwise `undefined`.
 *
 * @example
 * ```ts
 * inferType({ properties: { name: { type: 'string' } } }); // => 'object'
 * inferType({ items: { type: 'number' } });                 // => 'array'
 * inferType({ type: 'string' });                            // => undefined
 * ```
 */
export function inferType(schema: IJsonSchema): string | undefined {
  if (schema.properties || schema.additionalProperties) {
    return 'object';
  }
  if (schema.items) {
    return 'array';
  }
  return undefined;
}

/**
 * Derives a stable string key for an API operation.
 *
 * Prefers the `operationId` when it is a non-empty string; otherwise
 * falls back to a sanitised `"method_path"` form.
 *
 * @param operationId - The `operationId` declared in the OpenAPI operation (may be absent).
 * @param method - The HTTP method (e.g. `"get"`).
 * @param path - The URL path template (e.g. `"/pets/{petId}"`).
 * @returns A unique operation identifier safe for use as a JS identifier.
 *
 * @example
 * ```ts
 * toOperationKey('listPets', 'get', '/pets');      // => 'listPets'
 * toOperationKey(undefined, 'get', '/pets/{petId}'); // => 'get_pets_petId'
 * ```
 */
export function toOperationKey(operationId: unknown, method: string, path: string): string {
  if (typeof operationId === 'string' && operationId.length > 0) {
    return operationId;
  }
  return `${method}_${path}`
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Unescapes a single JSON Pointer token according to RFC 6901.
 *
 * `~1` → `/`, then `~0` → `~` (order matters).
 *
 * @param value - An escaped JSON Pointer segment.
 * @returns The unescaped segment.
 *
 * @example
 * ```ts
 * unescapeJsonPointer('pets~1{petId}'); // => 'pets/{petId}'
 * unescapeJsonPointer('name~0suffix');  // => 'name~suffix'
 * ```
 */
export function unescapeJsonPointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * If `input` contains a `$ref` property, resolves it against the OpenAPI
 * document; otherwise returns `input` unchanged.
 *
 * @param input - The value that may be a Reference Object.
 * @param pointer - JSON Pointer to `input` (used in diagnostics).
 * @param openApiObject - The root OpenAPI document for ref resolution.
 * @param diagnostics - Collector for any ref-resolution errors.
 * @returns The dereferenced value, or `input` as-is.
 */
export function dereference(
  input: unknown,
  pointer: string,
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
): unknown {
  if (!isObject(input) || typeof input.$ref !== 'string') {
    return input;
  }

  return resolveRef(input.$ref, openApiObject, pointer, diagnostics);
}

/**
 * Resolves a local JSON Reference (`#/…`) against the root OpenAPI document.
 *
 * Only local (same-document) references are supported. External or URL-based
 * refs produce a diagnostic and return an empty object.
 *
 * @param ref - The `$ref` string, e.g. `"#/components/schemas/Pet"`.
 * @param openApiObject - The root OpenAPI document.
 * @param pointer - JSON Pointer of the referring location (for diagnostics).
 * @param diagnostics - Collector for resolution errors.
 * @returns The resolved value, or `{}` if the ref cannot be followed.
 */
export function resolveRef(
  ref: string,
  openApiObject: OpenApiObject,
  pointer: string,
  diagnostics: DiagnosticCollector,
): unknown {
  if (!ref.startsWith('#/')) {
    diagnostics.push('unsupported-ref', `Only local refs are supported: ${ref}`, pointer);
    return {};
  }

  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => unescapeJsonPointer(part));

  let current: unknown = openApiObject;
  for (const part of parts) {
    if (!isObject(current) || !(part in current)) {
      diagnostics.push('invalid-ref', `Unable to resolve ref: ${ref}`, pointer);
      return {};
    }
    current = current[part];
  }

  return current;
}

/**
 * Serialises a value into a JavaScript literal string suitable for
 * embedding in generated source code.
 *
 * @param value - Any JSON-serialisable value.
 * @returns The JSON-stringified representation.
 *
 * @example
 * ```ts
 * toLiteral('hello'); // => '"hello"'
 * toLiteral(42);      // => '42'
 * toLiteral(true);    // => 'true'
 * toLiteral(null);    // => 'null'
 * ```
 */
export function toLiteral(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Dereferences and validates an OpenAPI Response Object.
 *
 * If validation fails a diagnostic is emitted and a minimal fallback
 * (`{ description: '' }`) is returned.
 *
 * @param input - Raw value from the spec (may be a `$ref`).
 * @param pointer - JSON Pointer to the response location.
 * @param openApiObject - The root OpenAPI document.
 * @param diagnostics - Collector for validation errors.
 * @returns A validated {@link ResponseObject}.
 */
export function normalizeResponse(
  input: unknown,
  pointer: string,
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
): ResponseObject {
  const deref = dereference(input, pointer, openApiObject, diagnostics);
  const result = ResponseObjectSchema.safeParse(deref);

  if (!result.success) {
    diagnostics.push(
      'invalid-response',
      `Response validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`,
      pointer,
    );
    return { description: '' };
  }

  return result.data;
}

/**
 * Normalises an array of OpenAPI Parameter Objects.
 *
 * Each element is dereferenced and validated individually via
 * {@link normalizeParameter}. A missing or non-array input yields an
 * empty list (with a diagnostic in the latter case).
 *
 * @param input - Raw parameters array from the spec.
 * @param pointer - JSON Pointer to the parameters location.
 * @param openApiObject - The root OpenAPI document.
 * @param diagnostics - Collector for validation errors.
 * @returns An array of validated {@link ParameterObject}s.
 */
export function normalizeParameters(
  input: unknown,
  pointer: string,
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
): ParameterObject[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    diagnostics.push('invalid-parameters', 'Parameters must be an array', pointer);
    return [];
  }
  return input.map((entry, index) =>
    normalizeParameter(entry, `${pointer}/${index}`, openApiObject, diagnostics),
  );
}

/**
 * Dereferences and validates a single OpenAPI Parameter Object.
 *
 * On validation failure a diagnostic is emitted and a safe fallback
 * (`{ name: '', in: 'query' }`) is returned.
 *
 * @param input - Raw value which may be a `$ref`.
 * @param pointer - JSON Pointer to the parameter.
 * @param openApiObject - The root OpenAPI document.
 * @param diagnostics - Collector for validation errors.
 * @returns A validated {@link ParameterObject}.
 */
export function normalizeParameter(
  input: unknown,
  pointer: string,
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
): ParameterObject {
  const deref = dereference(input, pointer, openApiObject, diagnostics);
  const result = ParameterObjectSchema.safeParse(deref);

  if (!result.success) {
    diagnostics.push(
      'invalid-parameter',
      `Parameter validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`,
      pointer,
    );
    return { name: '', in: 'query' };
  }

  return result.data;
}

/**
 * Dereferences and validates an OpenAPI Request Body Object.
 *
 * Returns a fallback (`{ content: {} }`) on validation failure.
 *
 * @param input - Raw value which may be a `$ref`.
 * @param pointer - JSON Pointer to the request body.
 * @param openApiObject - The root OpenAPI document.
 * @param diagnostics - Collector for validation errors.
 * @returns A validated {@link RequestBodyObject}.
 */
export function normalizeRequestBody(
  input: unknown,
  pointer: string,
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
): RequestBodyObject {
  const deref = dereference(input, pointer, openApiObject, diagnostics);
  const result = RequestBodyObjectSchema.safeParse(deref);

  if (!result.success) {
    diagnostics.push(
      'invalid-request-body',
      `Request body validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`,
      pointer,
    );
    return { content: {} };
  }

  return result.data;
}

/**
 * Ensures that the input is a valid JSON schema object.
 * @param input - The input to validate.
 * @param pointer - The JSON Pointer to the input location.
 * @param diagnostics - The diagnostic collector to report errors.
 *
 * @example
 * ```ts
 * ensureSchema({ type: 'string' }, '#/foo', diag); // => { type: 'string' }
 * ensureSchema('invalid', '#/foo', diag);           // => undefined (+ diagnostic)
 * ```
 */
export function ensureSchema(
  input: unknown,
  pointer: string,
  diagnostics: DiagnosticCollector,
): IJsonSchema | undefined {
  if (isObject(input) && 'type' in input) {
    return input as IJsonSchema;
  }
  diagnostics.push('invalid-schema', 'Expected schema object', pointer);
  return undefined;
}

/**
 * Ensures that the input is a plain object, emitting a diagnostic otherwise.
 *
 * @param input - The value to check.
 * @param pointer - JSON Pointer for diagnostic location.
 * @param diagnostics - The diagnostic collector.
 *
 * @example
 * ```ts
 * ensureObject({ a: 1 }, '#/foo', diag); // => { a: 1 }
 * ensureObject('nope', '#/foo', diag);    // => undefined (+ diagnostic)
 * ```
 */
export function ensureObject<T>(
  input: T,
  pointer: string,
  diagnostics: DiagnosticCollector,
): T | undefined {
  if (isObject(input)) {
    return input as T;
  }
  diagnostics.push('invalid-object', 'Expected object', pointer);
  return undefined;
}

/**
 * Type-guard that checks whether `input` is a non-null, non-array object.
 *
 * @param input - The value to test.
 * @returns `true` if `input` is a plain object.
 *
 * @example
 * ```ts
 * isObject({ a: 1 }); // => true
 * isObject([1, 2]);   // => false
 * isObject(null);     // => false
 * isObject('hello');  // => false
 * ```
 */
export function isObject(input: unknown): input is PlainObject {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * Returns the keys of `object` sorted in locale-aware alphabetical order.
 *
 * Used to ensure deterministic output when iterating over objects.
 *
 * @param object - A plain object.
 * @returns Sorted array of the object's own keys.
 *
 * @example
 * ```ts
 * sortKeys({ c: 3, a: 1, b: 2 }); // => ['a', 'b', 'c']
 * ```
 */
export function sortKeys(object: PlainObject): string[] {
  return Object.keys(object).sort((a, b) => a.localeCompare(b));
}

/**
 * Converts an arbitrary string into a valid JavaScript identifier.
 *
 * Non-alphanumeric characters are replaced with underscores, consecutive
 * underscores are collapsed, and a leading digit is prefixed with `_`.
 * An empty result defaults to `"Schema"`.
 *
 * @param value - The raw name to sanitise.
 * @returns A valid JS identifier.
 *
 * @example
 * ```ts
 * toIdentifier('Pet');            // => 'Pet'
 * toIdentifier('my-schema');      // => 'my_schema'
 * toIdentifier('123numeric');     // => '_123numeric'
 * toIdentifier('');               // => 'Schema'
 * ```
 */
export function toIdentifier(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) {
    return 'Schema';
  }
  const startsWithDigit = /^\d/.test(cleaned);
  return startsWithDigit ? `_${cleaned}` : cleaned;
}

/**
 * Returns `value` as-is when it is a valid unquoted JS property name,
 * otherwise wraps it in quotes via `JSON.stringify`.
 *
 * @param value - The property name to format.
 * @returns An expression safe for use as an object literal key.
 *
 * @example
 * ```ts
 * toPropertyKey('name');              // => 'name'
 * toPropertyKey('content-type');      // => '"content-type"'
 * toPropertyKey('application/json');  // => '"application/json"'
 * ```
 */
export function toPropertyKey(value: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Escapes a single JSON Pointer token according to RFC 6901.
 *
 * `~` → `~0`, `/` → `~1`.
 *
 * @param value - A raw JSON Pointer segment.
 * @returns The escaped segment.
 *
 * @example
 * ```ts
 * escapeJsonPointer('pets/{petId}'); // => 'pets~1{petId}'
 * escapeJsonPointer('name~suffix');  // => 'name~0suffix'
 * ```
 */
export function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
