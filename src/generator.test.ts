import { describe, expect, it } from 'bun:test';

import { generateZodSourceFromOpenApi } from './generator';
import type { OpenApiObject, SchemaOverrideContext } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal OpenAPI doc with given component schemas and paths. */
function makeSpec(
  opts: {
    schemas?: Record<string, unknown>;
    paths?: Record<string, unknown>;
  } = {},
): OpenApiObject {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: opts.paths ?? {},
    components: { schemas: opts.schemas ?? {} },
  } as OpenApiObject;
}

/** Shorthand generator call with non-strict mode. */
async function generate(
  spec: OpenApiObject,
  opts: Parameters<typeof generateZodSourceFromOpenApi>[1] = {},
) {
  return generateZodSourceFromOpenApi(spec, { strict: false, ...opts });
}

// ---------------------------------------------------------------------------
// Basic code generation
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - basics', () => {
  it('generates header and zod import', async () => {
    const { code } = await generate(makeSpec());
    expect(code).toContain('// Auto-generated');
    expect(code).toContain("import { z } from 'zod'");
  });

  it('generates component schema variables', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          Status: { type: 'string', enum: ['active', 'inactive'] },
        },
      }),
    );
    expect(code).toContain('const StatusSchema = z.enum(["active", "inactive"])');
    expect(code).toContain('Status: StatusSchema');
  });

  it('generates path operation schemas', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/items': {
            get: {
              parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('"/items"');
    expect(code).toContain('get:');
    expect(code).toContain('limit: z.int()');
    expect(code).toContain('z.array(z.string())');
  });
});

// ---------------------------------------------------------------------------
// Coerce option (integration)
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - coerce', () => {
  it('uses z.coerce.* when coerce is true', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          Count: { type: 'integer', minimum: 0 },
          Name: { type: 'string' },
          Active: { type: 'boolean' },
        },
      }),
      { coerce: true },
    );
    expect(code).toContain('z.coerce.number().int()');
    expect(code).toContain('z.coerce.string()');
    expect(code).toContain('z.coerce.boolean()');
  });

  it('does not use z.coerce.* when coerce is false', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          Count: { type: 'integer' },
          Name: { type: 'string' },
        },
      }),
      { coerce: false },
    );
    expect(code).not.toContain('z.coerce.');
  });
});

// ---------------------------------------------------------------------------
// Static overrides (integration)
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - static overrides', () => {
  it('overrides a component schema', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          MyDate: { type: 'string', format: 'date-time' },
        },
      }),
      {
        overrides: {
          '#/components/schemas/MyDate': 'z.coerce.date()',
        },
      },
    );
    expect(code).toContain('const MyDateSchema = z.coerce.date()');
    expect(code).not.toContain('z.iso.datetime()');
  });

  it('overrides a specific property', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          User: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              name: { type: 'string' },
            },
            required: ['email', 'name'],
          },
        },
      }),
      {
        overrides: {
          '#/components/schemas/User/properties/email': 'z.email().transform(v => v.toLowerCase())',
        },
      },
    );
    expect(code).toContain('email: z.email().transform(v => v.toLowerCase())');
    // name should remain unchanged
    expect(code).toContain('name: z.string()');
  });
});

// ---------------------------------------------------------------------------
// Override callback (integration)
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - overrideCallback', () => {
  it('can augment all string schemas', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          Simple: {
            type: 'object',
            properties: {
              a: { type: 'string' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
        },
      }),
      {
        overrideCallback: ({ type, generatedExpression }) => {
          if (type === 'string') return `${generatedExpression}.trim()`;
          return undefined;
        },
      },
    );
    expect(code).toContain('a: z.string().trim()');
    expect(code).toContain('b: z.number()');
    expect(code).not.toContain('z.number().trim()');
  });

  it('receives kind="schema" for schema nodes', async () => {
    const kinds: string[] = [];
    await generate(makeSpec({ schemas: { X: { type: 'string' } } }), {
      overrideCallback: ({ kind }) => {
        kinds.push(kind);
        return undefined;
      },
    });
    expect(kinds).toContain('schema');
  });
});

// ---------------------------------------------------------------------------
// Group-level overrides
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - group overrides', () => {
  const specWithParams = makeSpec({
    paths: {
      '/items/{id}': {
        get: {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { type: 'string' } },
              },
            },
          },
        },
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': { schema: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  });

  it('overrides all query params via static override', async () => {
    const { code } = await generate(specWithParams, {
      overrides: {
        '#/paths/~1items~1{id}/get/queryParams': 'myQuerySchema',
      },
    });
    expect(code).toContain('query: myQuerySchema,');
    // path params should be unaffected
    expect(code).toContain('id: z.string()');
  });

  it('overrides all path params via static override', async () => {
    const { code } = await generate(specWithParams, {
      overrides: {
        '#/paths/~1items~1{id}/get/pathParams': 'myPathSchema',
      },
    });
    expect(code).toContain('path: myPathSchema,');
  });

  it('overrides responses via static override', async () => {
    const { code } = await generate(specWithParams, {
      overrides: {
        '#/paths/~1items~1{id}/get/responses': 'myResponsesSchema',
      },
    });
    expect(code).toContain('responses: myResponsesSchema,');
  });

  it('overrides request body via static override', async () => {
    const { code } = await generate(specWithParams, {
      overrides: {
        '#/paths/~1items~1{id}/post/requestBody': 'myBodySchema',
      },
    });
    expect(code).toContain('requestBody: myBodySchema,');
  });

  it('overrides query params via callback', async () => {
    const { code } = await generate(specWithParams, {
      overrideCallback: ({ kind, pointer }) => {
        if (kind === 'query-params' && pointer.includes('~1items')) {
          return 'customQuerySchema';
        }
        return undefined;
      },
    });
    expect(code).toContain('query: customQuerySchema,');
  });

  it('callback receives kind and generatedExpression for groups', async () => {
    const groupContexts: SchemaOverrideContext[] = [];
    await generate(specWithParams, {
      overrideCallback: (ctx) => {
        if (ctx.kind !== 'schema') {
          groupContexts.push(ctx);
        }
        return undefined;
      },
    });
    const kinds = groupContexts.map((c) => c.kind);
    expect(kinds).toContain('path-params');
    expect(kinds).toContain('query-params');
    expect(kinds).toContain('responses');
    // All group contexts should have generatedExpression
    for (const ctx of groupContexts) {
      expect(typeof ctx.generatedExpression).toBe('string');
      expect(ctx.type).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - diagnostics', () => {
  it('returns diagnostics in non-strict mode', async () => {
    const spec = makeSpec({
      schemas: {
        Bad: { $ref: '#/components/schemas/DoesNotExist' },
      },
    });
    const { diagnostics } = await generate(spec, { strict: false });
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('throws in strict mode on error diagnostic', async () => {
    const spec = makeSpec({
      schemas: {
        Bad: { $ref: '#/components/schemas/DoesNotExist' },
      },
    });
    await expect(generateZodSourceFromOpenApi(spec, { strict: true })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Multiple HTTP methods on the same path
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - multiple methods', () => {
  it('generates separate schemas for GET and POST on the same path', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/items': {
            get: {
              operationId: 'listItems',
              parameters: [
                {
                  name: 'page',
                  in: 'query',
                  schema: { type: 'integer' },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
            post: {
              operationId: 'createItem',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { name: { type: 'string' } },
                      required: ['name'],
                    },
                  },
                },
              },
              responses: {
                '201': {
                  description: 'created',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { id: { type: 'integer' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    // GET /items - nested under path key + method key
    expect(code).toContain('"/items"');
    expect(code).toContain('get:');
    expect(code).toContain('page');
    // POST /items
    expect(code).toContain('post:');
    expect(code).toContain('name: z.string()');
  });
});

// ---------------------------------------------------------------------------
// Multiple response codes
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - multiple responses', () => {
  it('generates schemas for each response status code', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              responses: {
                '200': {
                  description: 'success',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                  },
                },
                '404': {
                  description: 'not found',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { message: { type: 'string' } },
                        required: ['message'],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('200');
    expect(code).toContain('404');
    expect(code).toContain('message: z.string()');
  });
});

// ---------------------------------------------------------------------------
// Component cross-references
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - component cross-references', () => {
  it('generates z.lazy() for schema referencing another component', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          Address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
            },
            required: ['street', 'city'],
          },
          Person: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: { $ref: '#/components/schemas/Address' },
            },
            required: ['name', 'address'],
          },
        },
      }),
    );
    expect(code).toContain('AddressSchema');
    expect(code).toContain('PersonSchema');
    expect(code).toContain('z.lazy(() => AddressSchema)');
  });

  it('handles recursive component schema', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          Category: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              children: {
                type: 'array',
                items: { $ref: '#/components/schemas/Category' },
              },
            },
            required: ['name'],
          },
        },
      }),
    );
    expect(code).toContain('CategorySchema');
    expect(code).toContain('z.lazy(() => CategorySchema)');
  });
});

// ---------------------------------------------------------------------------
// Path parameters in path operations
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - path parameters', () => {
  it('generates path param schema for operation-level params', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/users/{userId}': {
            get: {
              operationId: 'getUser',
              parameters: [
                {
                  name: 'userId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', format: 'uuid' },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('"/users/{userId}"');
    expect(code).toContain('userId');
    expect(code).toContain('z.uuid()');
  });
});

// ---------------------------------------------------------------------------
// Multiple paths
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - multiple paths', () => {
  it('generates schemas for each path', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/dogs': {
            get: {
              operationId: 'listDogs',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          '/cats': {
            get: {
              operationId: 'listCats',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('"/dogs"');
    expect(code).toContain('"/cats"');
    expect(code).toContain('z.array(z.string())');
    expect(code).toContain('z.array(z.number())');
  });
});

// ---------------------------------------------------------------------------
// $ref in path operation schemas
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - $ref in paths', () => {
  it('uses z.lazy() for $ref in request body', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          NewPet: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        paths: {
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/NewPet' },
                  },
                },
              },
              responses: {
                '201': {
                  description: 'created',
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/NewPet' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('NewPetSchema');
    // The path operation should reference the component via lazy
    expect(code).toContain('z.lazy(() => NewPetSchema)');
  });
});

// ---------------------------------------------------------------------------
// Coerce propagation to path operations
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi - coerce in path ops', () => {
  it('coerces query parameter types', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/search': {
            get: {
              operationId: 'search',
              parameters: [
                {
                  name: 'limit',
                  in: 'query',
                  schema: { type: 'integer' },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      { coerce: true },
    );
    expect(code).toContain('z.coerce.number()');
  });
});

// ---------------------------------------------------------------------------
// Invalid path item
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – invalid path item', () => {
  it('produces diagnostic for invalid path item and skips it', async () => {
    const { code, diagnostics } = await generate(
      makeSpec({
        paths: {
          '/good': {
            get: {
              operationId: 'good',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { type: 'string' } },
                  },
                },
              },
            },
          },
          // Invalid: path item is a string, not an object
          '/bad': 'not-a-path-item' as any,
        },
      }),
    );
    expect(code).toContain('"/good"');
    expect(diagnostics.some((d) => d.code === 'invalid-path-item')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Response fallback to non-JSON media type
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – non-JSON response', () => {
  it('falls back to first media type when application/json is absent', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/file': {
            get: {
              operationId: 'getFile',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'text/plain': {
                      schema: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('"200"');
    expect(code).toContain('z.string()');
  });
});

// ---------------------------------------------------------------------------
// Parameter with content instead of schema
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – parameter with content', () => {
  it('extracts schema from parameter content map', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/search': {
            get: {
              operationId: 'search',
              parameters: [
                {
                  name: 'filter',
                  in: 'query',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { field: { type: 'string' } },
                      },
                    },
                  },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(code).toContain('filter');
  });
});

// ---------------------------------------------------------------------------
// Parameter missing schema and content
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – missing parameter schema', () => {
  it('produces diagnostic when parameter has no schema or content', async () => {
    const { diagnostics } = await generate(
      makeSpec({
        paths: {
          '/items': {
            get: {
              operationId: 'listItems',
              parameters: [
                {
                  name: 'broken',
                  in: 'query',
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(diagnostics.some((d) => d.code === 'missing-parameter-schema')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Media type without schema
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – media type without schema', () => {
  it('produces diagnostic when media type object has no schema', async () => {
    const { diagnostics } = await generate(
      makeSpec({
        paths: {
          '/upload': {
            post: {
              operationId: 'upload',
              requestBody: {
                content: {
                  'application/octet-stream': {},
                },
              },
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(diagnostics.some((d) => d.code === 'missing-media-schema')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component schema variable name deduplication
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – var name dedup', () => {
  it('deduplicates schema var names that would collide', async () => {
    const { code } = await generate(
      makeSpec({
        schemas: {
          'my-schema': { type: 'string' },
          my_schema: { type: 'number' },
        },
      }),
    );
    // Both should be present; one gets a numeric suffix
    expect(code).toContain('my_schemaSchema');
    expect(code).toContain('my_schemaSchema2');
  });
});

// ---------------------------------------------------------------------------
// Path-level parameters merged with operation parameters
// ---------------------------------------------------------------------------
describe('generateZodSourceFromOpenApi – path-level params', () => {
  it('merges path-level and operation-level parameters', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/orgs/{orgId}/members': {
            parameters: [
              {
                name: 'orgId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            get: {
              operationId: 'listMembers',
              parameters: [
                {
                  name: 'page',
                  in: 'query',
                  schema: { type: 'integer' },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    // path-level param should be inherited
    expect(code).toContain('orgId');
    expect(code).toContain('page');
  });

  it('operation params override path-level params with same name+in', async () => {
    const { code } = await generate(
      makeSpec({
        paths: {
          '/items/{id}': {
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            get: {
              operationId: 'getItem',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'integer' },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      }),
    );
    // Operation-level override: integer, not string
    expect(code).toContain('z.int()');
    // Should NOT contain z.string() for id (only for response)
    // The path param should use integer
    expect(code).toContain('id: z.int()');
  });
});
