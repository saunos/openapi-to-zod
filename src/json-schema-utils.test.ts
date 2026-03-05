import { describe, expect, it } from 'bun:test';

import { DiagnosticCollector } from './diagnostics-collector';
import {
  inferType,
  toOperationKey,
  unescapeJsonPointer,
  escapeJsonPointer,
  dereference,
  resolveRef,
  toLiteral,
  normalizeResponse,
  normalizeParameters,
  normalizeParameter,
  normalizeRequestBody,
  ensureSchema,
  ensureObject,
  isObject,
  sortKeys,
  toIdentifier,
  toPropertyKey,
} from './json-schema-utils';
import type { OpenApiObject } from './types';

const emptyDoc: OpenApiObject = {
  openapi: '3.1.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {},
};

function makeDiag(strict = false) {
  return new DiagnosticCollector(strict);
}

// ---------------------------------------------------------------------------
// inferType
// ---------------------------------------------------------------------------
describe('inferType', () => {
  it('returns "object" when properties is present', () => {
    expect(inferType({ properties: { a: { type: 'string' } } })).toBe('object');
  });

  it('returns "object" when additionalProperties is present', () => {
    expect(inferType({ additionalProperties: true })).toBe('object');
  });

  it('returns "array" when items is present', () => {
    expect(inferType({ items: { type: 'number' } })).toBe('array');
  });

  it('returns undefined when no structural cues', () => {
    expect(inferType({ type: 'string' })).toBeUndefined();
  });

  it('returns undefined for empty schema', () => {
    expect(inferType({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toOperationKey
// ---------------------------------------------------------------------------
describe('toOperationKey', () => {
  it('uses operationId when provided', () => {
    expect(toOperationKey('listPets', 'get', '/pets')).toBe('listPets');
  });

  it('falls back to method_path when operationId is undefined', () => {
    expect(toOperationKey(undefined, 'get', '/pets/{petId}')).toBe('get_pets_petId');
  });

  it('falls back when operationId is empty string', () => {
    expect(toOperationKey('', 'post', '/users')).toBe('post_users');
  });

  it('falls back when operationId is non-string', () => {
    expect(toOperationKey(42, 'delete', '/items/{id}')).toBe('delete_items_id');
  });

  it('collapses multiple underscores', () => {
    expect(toOperationKey(undefined, 'get', '/a//b')).toBe('get_a_b');
  });
});

// ---------------------------------------------------------------------------
// unescapeJsonPointer / escapeJsonPointer
// ---------------------------------------------------------------------------
describe('unescapeJsonPointer', () => {
  it('unescapes ~1 to /', () => {
    expect(unescapeJsonPointer('pets~1{petId}')).toBe('pets/{petId}');
  });

  it('unescapes ~0 to ~', () => {
    expect(unescapeJsonPointer('name~0suffix')).toBe('name~suffix');
  });

  it('unescapes both in correct order', () => {
    expect(unescapeJsonPointer('a~0b~1c')).toBe('a~b/c');
  });
});

describe('escapeJsonPointer', () => {
  it('escapes ~ to ~0', () => {
    expect(escapeJsonPointer('name~suffix')).toBe('name~0suffix');
  });

  it('escapes / to ~1', () => {
    expect(escapeJsonPointer('pets/{petId}')).toBe('pets~1{petId}');
  });
});

// ---------------------------------------------------------------------------
// dereference
// ---------------------------------------------------------------------------
describe('dereference', () => {
  it('returns input unchanged when no $ref', () => {
    const diag = makeDiag();
    const input = { type: 'string' };
    expect(dereference(input, '#', emptyDoc, diag)).toBe(input);
  });

  it('returns non-object input unchanged', () => {
    const diag = makeDiag();
    expect(dereference('hello', '#', emptyDoc, diag)).toBe('hello');
    expect(dereference(null, '#', emptyDoc, diag)).toBeNull();
    expect(dereference(42, '#', emptyDoc, diag)).toBe(42);
  });

  it('resolves $ref when present', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: {
        schemas: {
          Pet: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    } as OpenApiObject;
    const result = dereference({ $ref: '#/components/schemas/Pet' }, '#', doc, diag);
    expect(result).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });
});

// ---------------------------------------------------------------------------
// resolveRef
// ---------------------------------------------------------------------------
describe('resolveRef', () => {
  it('resolves a valid local ref', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: { schemas: { Dog: { type: 'string' } } },
    } as OpenApiObject;
    expect(resolveRef('#/components/schemas/Dog', doc, '#', diag)).toEqual({
      type: 'string',
    });
    expect(diag.list()).toHaveLength(0);
  });

  it('emits diagnostic for non-local ref', () => {
    const diag = makeDiag();
    const result = resolveRef('https://example.com/schemas/Pet', emptyDoc, '#', diag);
    expect(result).toEqual({});
    expect(diag.list().some((d) => d.code === 'unsupported-ref')).toBe(true);
  });

  it('emits diagnostic for unresolvable local ref', () => {
    const diag = makeDiag();
    const result = resolveRef('#/components/schemas/DoesNotExist', emptyDoc, '#', diag);
    expect(result).toEqual({});
    expect(diag.list().some((d) => d.code === 'invalid-ref')).toBe(true);
  });

  it('resolves deeply nested refs', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: {
        schemas: {
          Nested: { type: 'number' },
        },
      },
    } as OpenApiObject;
    expect(resolveRef('#/components/schemas/Nested', doc, '#', diag)).toEqual({
      type: 'number',
    });
  });

  it('handles JSON pointer escapes in ref', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: {
        schemas: {
          'my/schema': { type: 'boolean' },
        },
      },
    } as OpenApiObject;
    expect(resolveRef('#/components/schemas/my~1schema', doc, '#', diag)).toEqual({
      type: 'boolean',
    });
  });
});

// ---------------------------------------------------------------------------
// toLiteral
// ---------------------------------------------------------------------------
describe('toLiteral', () => {
  it('serialises string', () => {
    expect(toLiteral('hello')).toBe('"hello"');
  });

  it('serialises number', () => {
    expect(toLiteral(42)).toBe('42');
  });

  it('serialises boolean', () => {
    expect(toLiteral(true)).toBe('true');
  });

  it('serialises null', () => {
    expect(toLiteral(null)).toBe('null');
  });
});

// ---------------------------------------------------------------------------
// normalizeResponse
// ---------------------------------------------------------------------------
describe('normalizeResponse', () => {
  it('returns validated response object', () => {
    const diag = makeDiag();
    const result = normalizeResponse({ description: 'OK' }, '#/r', emptyDoc, diag);
    expect(result.description).toBe('OK');
    expect(diag.list()).toHaveLength(0);
  });

  it('returns fallback and diagnostic on invalid response', () => {
    const diag = makeDiag();
    // missing required `description`
    const result = normalizeResponse('invalid', '#/r', emptyDoc, diag);
    expect(result).toEqual({ description: '' });
    expect(diag.list().some((d) => d.code === 'invalid-response')).toBe(true);
  });

  it('dereferences $ref before validation', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: {
        responses: {
          Ok: { description: 'Success' },
        },
      },
    } as OpenApiObject;
    const result = normalizeResponse({ $ref: '#/components/responses/Ok' }, '#/r', doc, diag);
    expect(result.description).toBe('Success');
  });
});

// ---------------------------------------------------------------------------
// normalizeParameters
// ---------------------------------------------------------------------------
describe('normalizeParameters', () => {
  it('returns empty array for undefined input', () => {
    const diag = makeDiag();
    expect(normalizeParameters(undefined, '#/p', emptyDoc, diag)).toEqual([]);
    expect(diag.list()).toHaveLength(0);
  });

  it('returns empty array and diagnostic for non-array input', () => {
    const diag = makeDiag();
    expect(normalizeParameters('bad', '#/p', emptyDoc, diag)).toEqual([]);
    expect(diag.list().some((d) => d.code === 'invalid-parameters')).toBe(true);
  });

  it('parses valid parameter array', () => {
    const diag = makeDiag();
    const params = normalizeParameters(
      [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      '#/p',
      emptyDoc,
      diag,
    );
    expect(params).toHaveLength(1);
    expect(params[0]?.name).toBe('id');
  });
});

// ---------------------------------------------------------------------------
// normalizeParameter
// ---------------------------------------------------------------------------
describe('normalizeParameter', () => {
  it('returns validated parameter', () => {
    const diag = makeDiag();
    const result = normalizeParameter(
      { name: 'limit', in: 'query', schema: { type: 'integer' } },
      '#/p/0',
      emptyDoc,
      diag,
    );
    expect(result.name).toBe('limit');
    expect(diag.list()).toHaveLength(0);
  });

  it('returns fallback and diagnostic on invalid parameter', () => {
    const diag = makeDiag();
    const result = normalizeParameter('not-an-object', '#/p/0', emptyDoc, diag);
    expect(result).toEqual({ name: '', in: 'query' });
    expect(diag.list().some((d) => d.code === 'invalid-parameter')).toBe(true);
  });

  it('dereferences $ref before validation', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: {
        parameters: {
          LimitParam: {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
          },
        },
      },
    } as OpenApiObject;
    const result = normalizeParameter(
      { $ref: '#/components/parameters/LimitParam' },
      '#/p/0',
      doc,
      diag,
    );
    expect(result.name).toBe('limit');
  });
});

// ---------------------------------------------------------------------------
// normalizeRequestBody
// ---------------------------------------------------------------------------
describe('normalizeRequestBody', () => {
  it('returns validated request body', () => {
    const diag = makeDiag();
    const result = normalizeRequestBody(
      {
        content: {
          'application/json': { schema: { type: 'object' } },
        },
      },
      '#/rb',
      emptyDoc,
      diag,
    );
    expect(result.content).toBeDefined();
    expect(diag.list()).toHaveLength(0);
  });

  it('returns fallback and diagnostic on invalid request body', () => {
    const diag = makeDiag();
    const result = normalizeRequestBody('invalid', '#/rb', emptyDoc, diag);
    expect(result).toEqual({ content: {} });
    expect(diag.list().some((d) => d.code === 'invalid-request-body')).toBe(true);
  });

  it('dereferences $ref before validation', () => {
    const diag = makeDiag();
    const doc = {
      ...emptyDoc,
      components: {
        requestBodies: {
          PetBody: {
            content: {
              'application/json': { schema: { type: 'object' } },
            },
          },
        },
      },
    } as OpenApiObject;
    const result = normalizeRequestBody(
      { $ref: '#/components/requestBodies/PetBody' },
      '#/rb',
      doc,
      diag,
    );
    expect(result.content).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ensureSchema
// ---------------------------------------------------------------------------
describe('ensureSchema', () => {
  it('returns schema when valid', () => {
    const diag = makeDiag();
    const schema = { type: 'string' };
    expect(ensureSchema(schema, '#', diag)).toBe(schema);
    expect(diag.list()).toHaveLength(0);
  });

  it('returns undefined and emits diagnostic for non-object', () => {
    const diag = makeDiag();
    expect(ensureSchema('invalid', '#', diag)).toBeUndefined();
    expect(diag.list().some((d) => d.code === 'invalid-schema')).toBe(true);
  });

  it('returns undefined for object without type', () => {
    const diag = makeDiag();
    expect(ensureSchema({ foo: 'bar' }, '#', diag)).toBeUndefined();
    expect(diag.list().some((d) => d.code === 'invalid-schema')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureObject
// ---------------------------------------------------------------------------
describe('ensureObject', () => {
  it('returns object when valid', () => {
    const diag = makeDiag();
    const obj = { a: 1 };
    expect(ensureObject(obj, '#', diag)).toBe(obj);
    expect(diag.list()).toHaveLength(0);
  });

  it('returns undefined and emits diagnostic for non-object', () => {
    const diag = makeDiag();
    expect(ensureObject('str', '#', diag)).toBeUndefined();
    expect(diag.list().some((d) => d.code === 'invalid-object')).toBe(true);
  });

  it('returns undefined for null', () => {
    const diag = makeDiag();
    expect(ensureObject(null, '#', diag)).toBeUndefined();
    expect(diag.list()).toHaveLength(1);
  });

  it('returns undefined for array', () => {
    const diag = makeDiag();
    expect(ensureObject([1, 2], '#', diag)).toBeUndefined();
    expect(diag.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// isObject
// ---------------------------------------------------------------------------
describe('isObject', () => {
  it('returns true for plain objects', () => {
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject({})).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isObject([1, 2])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isObject(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isObject('str')).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortKeys
// ---------------------------------------------------------------------------
describe('sortKeys', () => {
  it('sorts keys alphabetically', () => {
    expect(sortKeys({ c: 3, a: 1, b: 2 })).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for empty object', () => {
    expect(sortKeys({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toIdentifier
// ---------------------------------------------------------------------------
describe('toIdentifier', () => {
  it('keeps valid identifiers', () => {
    expect(toIdentifier('Pet')).toBe('Pet');
  });

  it('replaces special chars with underscores', () => {
    expect(toIdentifier('my-schema')).toBe('my_schema');
  });

  it('prefixes identifiers starting with digit', () => {
    expect(toIdentifier('123numeric')).toBe('_123numeric');
  });

  it('returns "Schema" for empty string', () => {
    expect(toIdentifier('')).toBe('Schema');
  });

  it('collapses multiple underscores', () => {
    expect(toIdentifier('a--b')).toBe('a_b');
  });
});

// ---------------------------------------------------------------------------
// toPropertyKey
// ---------------------------------------------------------------------------
describe('toPropertyKey', () => {
  it('returns identifier as-is', () => {
    expect(toPropertyKey('name')).toBe('name');
  });

  it('quotes keys with special characters', () => {
    expect(toPropertyKey('content-type')).toBe('"content-type"');
    expect(toPropertyKey('application/json')).toBe('"application/json"');
  });

  it('quotes keys starting with digit', () => {
    expect(toPropertyKey('123')).toBe('"123"');
  });
});
