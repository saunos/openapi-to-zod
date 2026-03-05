# json-schema-zod-tools

Generate TypeScript source that exports Zod 4 schemas from an OpenAPI JSON object.

## Install

```bash
npm install @saunos/openapi-to-zod
# or
bun add @saunos/openapi-to-zod
```

## CLI usage

Run directly with `npx` — no install needed:

```bash
npx openapi-to-zod https://example.com/openapi.json example.ts
```

Or from a local file:

```bash
npx openapi-to-zod ./openapi.json ./generated/schemas.ts
```

With options:

```bash
# Coerce primitive types (z.coerce.*)
npx openapi-to-zod ./openapi.json ./schemas.ts --coerce

# Override a specific schema with a custom Zod expression
npx openapi-to-zod ./openapi.json ./schemas.ts \
  --override "#/components/schemas/Date=z.coerce.date()"
```

Run `npx openapi-to-zod --help` for the full reference.

## Library API

```ts
import { generateZodSourceFromOpenApi } from '@saunos/openapi-to-zod';

const res = await fetch('https://example.com/openapi.json');
const openApiObject = await res.json();

const { code, diagnostics } = await generateZodSourceFromOpenApi(openApiObject, {
  strict: true,
});

await Bun.write('./schemas.ts', code);
```

`strict: true` fails fast on the first extraction/conversion error with pointer details.

### Convert a single JSON Schema

For cases where you have a standalone JSON Schema (not a full OpenAPI document):

```ts
import { convertJsonSchemaToZod } from '@saunos/openapi-to-zod';

const { expression, diagnostics } = convertJsonSchemaToZod({
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
    tags: { type: 'array', items: { type: 'string' } },
  },
});

console.log(expression);
// z.object({
//   age: z.int().min(0).optional(),
//   id: z.uuid(),
//   name: z.string(),
//   tags: z.array(z.string()).optional(),
// })
```

> **Note:** `$ref` pointers to `#/components/schemas/*` are not resolved by this function — use `generateZodSourceFromOpenApi` for schemas with cross-references.

## Example

Given [`examples/bookstore.openapi.json`](./examples/bookstore.openapi.json):

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Bookstore API", "version": "1.0.0" },
  "paths": {
    "/books": {
      "get": {
        "parameters": [
          {
            "name": "genre",
            "in": "query",
            "schema": {
              "type": "string",
              "enum": ["fiction", "non-fiction", "science", "history"]
            }
          },
          {
            "name": "page",
            "in": "query",
            "schema": { "type": "integer", "minimum": 1 }
          },
          {
            "name": "size",
            "in": "query",
            "schema": { "type": "integer", "minimum": 1, "maximum": 100 }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/BookPage" }
              }
            }
          }
        }
      },
      "post": {
        "requestBody": {
          "content": {
            "application/json": {
              "schema": { "$ref": "#/components/schemas/BookCreate" }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/Book" }
              }
            }
          }
        }
      }
    },
    "/books/{id}": {
      "get": {
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": { "type": "string", "format": "uuid" }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/Book" }
              }
            }
          },
          "404": {
            "description": "Not found",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/Error" }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "Genre": {
        "type": "string",
        "enum": ["fiction", "non-fiction", "science", "history"]
      },
      "Book": {
        "type": "object",
        "required": ["id", "title", "author", "genre", "published_at"],
        "properties": {
          "id": { "type": "string", "format": "uuid" },
          "title": { "type": "string" },
          "author": { "type": "string" },
          "genre": { "$ref": "#/components/schemas/Genre" },
          "published_at": { "type": "string", "format": "date-time" },
          "rating": { "type": "number", "minimum": 0, "maximum": 5 }
        }
      },
      "BookCreate": {
        "type": "object",
        "required": ["title", "author", "genre"],
        "properties": {
          "title": { "type": "string" },
          "author": { "type": "string" },
          "genre": { "$ref": "#/components/schemas/Genre" },
          "published_at": {
            "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }]
          }
        }
      },
      "BookPage": {
        "type": "object",
        "required": ["items", "total", "page", "size"],
        "properties": {
          "items": {
            "type": "array",
            "items": { "$ref": "#/components/schemas/Book" }
          },
          "total": { "type": "integer", "minimum": 0 },
          "page": { "type": "integer", "minimum": 1 },
          "size": { "type": "integer", "minimum": 1 }
        }
      },
      "Error": {
        "type": "object",
        "required": ["code", "message"],
        "properties": {
          "code": { "type": "string" },
          "message": { "type": "string" }
        }
      }
    }
  }
}
```

Running:

```bash
npx openapi-to-zod ./examples/bookstore.openapi.json ./examples/bookstore.generated.ts
```

Produces [`examples/bookstore.generated.ts`](./examples/bookstore.generated.ts):

```ts
// Auto-generated by json-schema-zod-tools.
import { z } from 'zod';

const BookSchema = z.object({
  author: z.string(),
  genre: z.lazy(() => GenreSchema),
  id: z.uuid(),
  published_at: z.iso.datetime(),
  rating: z.number().min(0).max(5).optional(),
  title: z.string(),
});
const BookCreateSchema = z.object({
  author: z.string(),
  genre: z.lazy(() => GenreSchema),
  published_at: z.union([z.iso.datetime(), z.null()]).optional(),
  title: z.string(),
});
const BookPageSchema = z.object({
  items: z.array(z.lazy(() => BookSchema)),
  page: z.int().min(1),
  size: z.int().min(1),
  total: z.int().min(0),
});
const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
const GenreSchema = z.enum(['fiction', 'non-fiction', 'science', 'history']);

export const schemas = {
  paths: {
    '/books': {
      get: {
        path: z.object({}),
        query: z.object({
          genre: z.enum(['fiction', 'non-fiction', 'science', 'history']),
          page: z.int().min(1),
          size: z.int().min(1).max(100),
        }),
        responses: {
          '200': z.lazy(() => BookPageSchema),
        },
      },
      post: {
        path: z.object({}),
        query: z.object({}),
        requestBody: {
          'application/json': z.lazy(() => BookCreateSchema),
        },
        responses: {
          '201': z.lazy(() => BookSchema),
        },
      },
    },
    '/books/{id}': {
      get: {
        path: z.object({
          id: z.uuid(),
        }),
        query: z.object({}),
        responses: {
          '200': z.lazy(() => BookSchema),
          '404': z.lazy(() => ErrorSchema),
        },
      },
    },
  },
  components: {
    schemas: {
      Book: BookSchema,
      BookCreate: BookCreateSchema,
      BookPage: BookPageSchema,
      Error: ErrorSchema,
      Genre: GenreSchema,
    },
  },
} as const;
```

## Generated exports

A single `schemas` constant is exported with the following shape:

```ts
export const schemas = {
  paths: {
    // keyed by path string, then HTTP method
    '/resource/{id}': {
      get: {
        path: z.object({ ... }),      // path parameters
        query: z.object({ ... }),     // query parameters
        requestBody: {                // optional — only present when defined
          'application/json': z.lazy(() => ...),
        },
        responses: {
          '200': z.lazy(() => ...),
        },
      },
    },
  },
  components: {
    schemas: {
      // keyed by component schema name
      MySchema: MySchemaSchema,
    },
  },
} as const;
```

## License

[MIT](./LICENSE)
