/**
 * Structural validators for the OpenAPI 3.1 objects this generator consumes.
 *
 * `@scalar/openapi-types` dropped its runtime Zod schema entrypoints in
 * v0.7.0 (`@scalar/openapi-types/schemas/3.1/*`) and now ships types only,
 * so the required-field checks that used to come from `safeParse` live here.
 * Each validator returns a discriminated result carrying either the narrowed
 * value or a list of human-readable issues for the diagnostic collector.
 *
 * @module openapi-validators
 */

import type { IJsonSchema } from '@scalar/openapi-types';
import type { ParameterObject, PathItemObject, RequestBodyObject, ResponseObject } from './types';

/** Outcome of a structural validation. */
export type ValidationResult<T> = { success: true; data: T } | { success: false; issues: string[] };

/** Local plain-object guard, kept here to avoid a module cycle with `json-schema-utils`. */
function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

const PARAMETER_LOCATIONS = ['query', 'header', 'path', 'cookie'];

function failure(...issues: string[]): { success: false; issues: string[] } {
  return { success: false, issues };
}

/**
 * Joins validation issues into the single-line form used in diagnostics.
 *
 * @param issues - Issues from a failed {@link ValidationResult}.
 * @returns A comma-separated message.
 */
export function formatIssues(issues: string[]): string {
  return issues.join(', ');
}

/**
 * Validates a JSON Schema / OpenAPI Schema Object.
 *
 * OpenAPI 3.1 schemas are JSON Schema, so only the structural requirement
 * (a plain object) is enforced; keyword-level checks happen during conversion.
 *
 * @param input - Raw value from the spec.
 * @returns The value narrowed to {@link IJsonSchema}, or the issues found.
 */
export function validateSchemaObject(input: unknown): ValidationResult<IJsonSchema> {
  if (!isObject(input)) {
    return failure('Expected a schema object');
  }
  return { success: true, data: input as IJsonSchema };
}

/**
 * Validates an OpenAPI Path Item Object.
 *
 * @param input - Raw value from the spec.
 * @returns The value narrowed to {@link PathItemObject}, or the issues found.
 */
export function validatePathItemObject(input: unknown): ValidationResult<PathItemObject> {
  if (!isObject(input)) {
    return failure('Expected a path item object');
  }
  if (input.parameters !== undefined && !Array.isArray(input.parameters)) {
    return failure('Expected "parameters" to be an array');
  }
  return { success: true, data: input as PathItemObject };
}

/**
 * Validates an OpenAPI Parameter Object, requiring `name` and `in`.
 *
 * @param input - Raw value from the spec (already dereferenced).
 * @returns The value narrowed to {@link ParameterObject}, or the issues found.
 */
export function validateParameterObject(input: unknown): ValidationResult<ParameterObject> {
  if (!isObject(input)) {
    return failure('Expected a parameter object');
  }

  const issues: string[] = [];
  if (typeof input.name !== 'string') {
    issues.push('Expected "name" to be a string');
  }
  if (typeof input.in !== 'string' || !PARAMETER_LOCATIONS.includes(input.in)) {
    issues.push(`Expected "in" to be one of ${PARAMETER_LOCATIONS.join(', ')}`);
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }
  return { success: true, data: input as ParameterObject };
}

/**
 * Validates an OpenAPI Request Body Object, requiring a `content` map.
 *
 * @param input - Raw value from the spec (already dereferenced).
 * @returns The value narrowed to {@link RequestBodyObject}, or the issues found.
 */
export function validateRequestBodyObject(input: unknown): ValidationResult<RequestBodyObject> {
  if (!isObject(input)) {
    return failure('Expected a request body object');
  }
  if (!isObject(input.content)) {
    return failure('Expected "content" to be an object');
  }
  return { success: true, data: input as RequestBodyObject };
}

/**
 * Validates an OpenAPI Response Object, requiring a `description` string.
 *
 * @param input - Raw value from the spec (already dereferenced).
 * @returns The value narrowed to {@link ResponseObject}, or the issues found.
 */
export function validateResponseObject(input: unknown): ValidationResult<ResponseObject> {
  if (!isObject(input)) {
    return failure('Expected a response object');
  }
  if (typeof input.description !== 'string') {
    return failure('Expected "description" to be a string');
  }
  if (input.content !== undefined && !isObject(input.content)) {
    return failure('Expected "content" to be an object');
  }
  return { success: true, data: input as ResponseObject };
}
