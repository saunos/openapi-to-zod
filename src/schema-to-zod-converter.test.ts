import { describe, expect, it } from 'bun:test';

import { DiagnosticCollector } from './diagnostics-collector';
import { SchemaToZodConverter } from './schema-to-zod-converter';
import type { OpenApiObject, SchemaOverrideContext } from './types';

/** Minimal OpenAPI doc used as the root context for the converter. */
const emptyDoc: OpenApiObject = {
  openapi: '3.1.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {},
};

/** Creates a converter with sensible defaults for unit testing. */
function createConverter(
  opts: {
    useDateCodecs?: boolean;
    alphabetical?: boolean;
    overrides?: Record<string, string>;
    overrideCallback?: (ctx: SchemaOverrideContext) => string | undefined;
    componentSchemaVarNames?: Record<string, string>;
    doc?: OpenApiObject;
  } = {},
) {
  const diagnostics = new DiagnosticCollector(false);
  const converter = new SchemaToZodConverter(
    opts.doc ?? emptyDoc,
    opts.componentSchemaVarNames ?? {},
    diagnostics,
    opts.useDateCodecs ?? false,
    opts.overrides ?? {},
    opts.overrideCallback,
    true,
    opts.alphabetical ?? false,
  );
  return { converter, diagnostics };
}

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - primitives', () => {
  it('converts string', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string' }, '#')).toBe('z.string()');
  });

  it('converts number', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'number' }, '#')).toBe('z.number()');
  });

  it('converts integer', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'integer' }, '#')).toBe('z.int()');
  });

  it('converts boolean', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'boolean' }, '#')).toBe('z.boolean()');
  });

  it('converts null', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'null' }, '#')).toBe('z.null()');
  });

  it('returns z.unknown() for unknown/missing type', () => {
    const { converter } = createConverter();
    expect(converter.convert({}, '#')).toBe('z.unknown()');
  });
});

// ---------------------------------------------------------------------------
// String formats
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - string formats', () => {
  it('converts format: email', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'email' }, '#')).toBe('z.email()');
  });

  it('converts format: uuid', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'uuid' }, '#')).toBe('z.uuid()');
  });

  it('converts format: uri', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'uri' }, '#')).toBe('z.url()');
  });

  it('converts format: date-time', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'date-time' }, '#')).toBe(
      'z.iso.datetime()',
    );
  });

  it('converts format: date', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'date' }, '#')).toBe('z.iso.date()');
  });
});

// ---------------------------------------------------------------------------
// String constraints
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - string constraints', () => {
  it('applies minLength', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', minLength: 1 }, '#')).toBe('z.string().min(1)');
  });

  it('applies maxLength', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', maxLength: 100 }, '#')).toBe('z.string().max(100)');
  });

  it('applies pattern', () => {
    const { converter } = createConverter();
    const result = converter.convert({ type: 'string', pattern: '^[a-z]+$' }, '#');
    expect(result).toBe('z.string().regex(new RegExp("^[a-z]+$"))');
  });

  it('applies min + max + pattern together', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      { type: 'string', minLength: 1, maxLength: 50, pattern: '^\\w+$' },
      '#',
    );
    expect(result).toBe('z.string().min(1).max(50).regex(new RegExp("^\\\\w+$"))');
  });

  it('does not apply string constraints to format schemas', () => {
    const { converter } = createConverter();
    // email format should ignore minLength
    expect(converter.convert({ type: 'string', format: 'email', minLength: 5 }, '#')).toBe(
      'z.email()',
    );
  });
});

// ---------------------------------------------------------------------------
// Number constraints
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - number constraints', () => {
  it('applies minimum and maximum', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'number', minimum: 0, maximum: 100 }, '#')).toBe(
      'z.number().min(0).max(100)',
    );
  });

  it('applies exclusiveMinimum and exclusiveMaximum', () => {
    const { converter } = createConverter();
    expect(
      converter.convert({ type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 100 }, '#'),
    ).toBe('z.number().gt(1).lt(100)');
  });

  it('applies multipleOf', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'number', multipleOf: 0.01 }, '#')).toBe(
      'z.number().multipleOf(0.01)',
    );
  });
});

// ---------------------------------------------------------------------------
// Integer constraints
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - integer constraints', () => {
  it('applies min/max to integer', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'integer', minimum: 1, maximum: 10 }, '#')).toBe(
      'z.int().min(1).max(10)',
    );
  });

  it('applies exclusive bounds to integer', () => {
    const { converter } = createConverter();
    expect(
      converter.convert({ type: 'integer', exclusiveMinimum: 1, exclusiveMaximum: 100 }, '#'),
    ).toBe('z.int().gt(1).lt(100)');
  });
});

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - enum', () => {
  it('converts string enum', () => {
    const { converter } = createConverter();
    expect(converter.convert({ enum: ['a', 'b', 'c'] }, '#')).toBe('z.enum(["a", "b", "c"])');
  });

  it('converts mixed enum as union of literals', () => {
    const { converter } = createConverter();
    expect(converter.convert({ enum: [1, 'two', true] }, '#')).toBe(
      'z.union([z.literal(1), z.literal("two"), z.literal(true)])',
    );
  });

  it('converts single-value enum', () => {
    const { converter } = createConverter();
    expect(converter.convert({ enum: ['only'] }, '#')).toBe('z.enum(["only"])');
  });

  it('emits z.never() for empty enum', () => {
    const { converter } = createConverter();
    expect(converter.convert({ enum: [] }, '#')).toBe('z.never()');
  });
});

// ---------------------------------------------------------------------------
// Const
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - const', () => {
  it('converts string const', () => {
    const { converter } = createConverter();
    expect(converter.convert({ const: 'hello' }, '#')).toBe('z.literal("hello")');
  });

  it('converts numeric const', () => {
    const { converter } = createConverter();
    expect(converter.convert({ const: 42 }, '#')).toBe('z.literal(42)');
  });

  it('converts boolean const', () => {
    const { converter } = createConverter();
    expect(converter.convert({ const: true }, '#')).toBe('z.literal(true)');
  });
});

// ---------------------------------------------------------------------------
// Array
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - array', () => {
  it('converts basic array', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'array', items: { type: 'string' } }, '#')).toBe(
      'z.array(z.string())',
    );
  });

  it('applies minItems and maxItems', () => {
    const { converter } = createConverter();
    expect(
      converter.convert(
        { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 10 },
        '#',
      ),
    ).toBe('z.array(z.number()).min(1).max(10)');
  });

  it('defaults to z.unknown() items when items not specified', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'array' }, '#')).toBe('z.array(z.unknown())');
  });
});

// ---------------------------------------------------------------------------
// Object
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - object', () => {
  it('converts empty object', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'object' }, '#')).toBe('z.object({})');
  });

  it('converts object with required and optional properties', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      },
      '#',
    );
    expect(result).toContain('name: z.string(),');
    expect(result).toContain('age: z.int().optional(),');
  });

  it('applies .strict() when additionalProperties is false', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      { type: 'object', properties: {}, additionalProperties: false },
      '#',
    );
    expect(result).toBe('z.object({}).strict()');
  });

  it('applies .catchall() when additionalProperties is a schema', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      { type: 'object', additionalProperties: { type: 'string' } },
      '#',
    );
    expect(result).toBe('z.object({}).catchall(z.string())');
  });
});

// ---------------------------------------------------------------------------
// Nullable
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - nullable', () => {
  it('handles nullable via type array ["string", "null"]', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: ['string', 'null'] }, '#')).toBe(
      'z.union([z.string(), z.null()])',
    );
  });
});

// ---------------------------------------------------------------------------
// Union types (type array, anyOf, oneOf)
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - unions', () => {
  it('converts type array to union', () => {
    const { converter } = createConverter();
    const result = converter.convert({ type: ['string', 'number'] }, '#');
    expect(result).toBe('z.union([z.string(), z.number()])');
  });

  it('converts type array with null', () => {
    const { converter } = createConverter();
    const result = converter.convert({ type: ['string', 'null'] }, '#');
    expect(result).toBe('z.union([z.string(), z.null()])');
  });

  it('converts anyOf', () => {
    const { converter } = createConverter();
    const result = converter.convert({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, '#');
    expect(result).toBe('z.union([z.string(), z.int()])');
  });

  it('converts oneOf', () => {
    const { converter } = createConverter();
    const result = converter.convert({ oneOf: [{ type: 'boolean' }, { type: 'number' }] }, '#');
    expect(result).toBe('z.union([z.boolean(), z.number()])');
  });

  it('unwraps single-element anyOf', () => {
    const { converter } = createConverter();
    expect(converter.convert({ anyOf: [{ type: 'string' }] }, '#')).toBe('z.string()');
  });
});

// ---------------------------------------------------------------------------
// Intersection (allOf)
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - allOf', () => {
  it('converts allOf with two schemas', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
      },
      '#',
    );
    expect(result).toStartWith('z.intersection(');
    expect(result).toContain('a: z.string()');
    expect(result).toContain('b: z.number()');
  });

  it('unwraps single-element allOf', () => {
    const { converter } = createConverter();
    const result = converter.convert({ allOf: [{ type: 'string' }] }, '#');
    expect(result).toBe('z.string()');
  });
});

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - $ref', () => {
  it('resolves component schema ref as z.lazy()', () => {
    const { converter } = createConverter({
      componentSchemaVarNames: { Pet: 'PetSchema' },
    });
    expect(converter.convert({ $ref: '#/components/schemas/Pet' }, '#')).toBe(
      'z.lazy(() => PetSchema)',
    );
  });

  it('emits z.unknown() for unknown ref', () => {
    const { converter, diagnostics } = createConverter();
    expect(converter.convert({ $ref: '#/components/schemas/Missing' }, '#')).toBe('z.unknown()');
    expect(diagnostics.list()).toHaveLength(1);
    expect(diagnostics.list()[0]!.code).toBe('missing-component-schema');
  });
});

// ---------------------------------------------------------------------------
// useDateCodecs option
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - useDateCodecs option', () => {
  it('emits reference name for date-time format', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    expect(converter.convert({ type: 'string', format: 'date-time' }, '#')).toBe(
      'isoDatetimeToDate',
    );
  });

  it('emits reference name for date format', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    expect(converter.convert({ type: 'string', format: 'date' }, '#')).toBe('isoDateToDate');
  });

  it('tracks used codecs', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    converter.convert({ type: 'string', format: 'date-time' }, '#/a');
    converter.convert({ type: 'string', format: 'date' }, '#/b');
    converter.convert({ type: 'string', format: 'date-time' }, '#/c');
    expect(converter.getUsedCodecs()).toEqual(new Set(['datetime', 'date']));
  });

  it('tracks only datetime when only date-time is used', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    converter.convert({ type: 'string', format: 'date-time' }, '#');
    expect(converter.getUsedCodecs()).toEqual(new Set(['datetime']));
  });

  it('does not affect other format schemas', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    expect(converter.convert({ type: 'string', format: 'email' }, '#')).toBe('z.email()');
    expect(converter.convert({ type: 'string', format: 'uuid' }, '#')).toBe('z.uuid()');
  });

  it('does not affect primitive types', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    expect(converter.convert({ type: 'string' }, '#')).toBe('z.string()');
    expect(converter.convert({ type: 'number' }, '#')).toBe('z.number()');
    expect(converter.convert({ type: 'integer' }, '#')).toBe('z.int()');
    expect(converter.convert({ type: 'boolean' }, '#')).toBe('z.boolean()');
  });

  it('emits plain iso schemas when useDateCodecs is false', () => {
    const { converter } = createConverter({ useDateCodecs: false });
    expect(converter.convert({ type: 'string', format: 'date-time' }, '#')).toBe(
      'z.iso.datetime()',
    );
    expect(converter.convert({ type: 'string', format: 'date' }, '#')).toBe('z.iso.date()');
    expect(converter.getUsedCodecs().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Static overrides
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - static overrides', () => {
  it('replaces schema at exact pointer with override', () => {
    const { converter } = createConverter({
      overrides: { '#/test': 'z.coerce.date()' },
    });
    expect(converter.convert({ type: 'string' }, '#/test')).toBe('z.coerce.date()');
  });

  it('does not affect other pointers', () => {
    const { converter } = createConverter({
      overrides: { '#/test': 'z.coerce.date()' },
    });
    expect(converter.convert({ type: 'string' }, '#/other')).toBe('z.string()');
  });

  it('takes precedence over callback', () => {
    const { converter } = createConverter({
      overrides: { '#/test': 'STATIC' },
      overrideCallback: () => 'CALLBACK',
    });
    expect(converter.convert({ type: 'string' }, '#/test')).toBe('STATIC');
  });
});

// ---------------------------------------------------------------------------
// Override callback
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - overrideCallback', () => {
  it('receives correct context', () => {
    const contexts: SchemaOverrideContext[] = [];
    const { converter } = createConverter({
      overrideCallback: (ctx) => {
        contexts.push(ctx);
        return undefined;
      },
    });
    converter.convert({ type: 'string' }, '#/test');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.pointer).toBe('#/test');
    expect(contexts[0]!.kind).toBe('schema');
    expect(contexts[0]!.type).toBe('string');
    expect(contexts[0]!.generatedExpression).toBe('z.string()');
  });

  it('replaces expression when callback returns a string', () => {
    const { converter } = createConverter({
      overrideCallback: ({ generatedExpression }) => `${generatedExpression}.brand()`,
    });
    expect(converter.convert({ type: 'string' }, '#')).toBe('z.string().brand()');
  });

  it('keeps default when callback returns undefined', () => {
    const { converter } = createConverter({
      overrideCallback: () => undefined,
    });
    expect(converter.convert({ type: 'number' }, '#')).toBe('z.number()');
  });

  it('is called for nested schemas', () => {
    const pointers: string[] = [];
    const { converter } = createConverter({
      overrideCallback: ({ pointer }) => {
        pointers.push(pointer);
        return undefined;
      },
    });
    converter.convert(
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      '#/root',
    );
    // Should be called for root object and nested 'name' property
    expect(pointers).toContain('#/root');
    expect(pointers).toContain('#/root/properties/name');
  });

  it('can selectively override based on type', () => {
    const { converter } = createConverter({
      overrideCallback: ({ type, generatedExpression }) => {
        if (type === 'string') return `${generatedExpression}.trim()`;
        return undefined;
      },
    });
    expect(converter.convert({ type: 'string' }, '#')).toBe('z.string().trim()');
    expect(converter.convert({ type: 'number' }, '#')).toBe('z.number()');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - diagnostics', () => {
  it('produces diagnostic for invalid schema', () => {
    const { converter, diagnostics } = createConverter();
    // Passing a non-object should trigger a diagnostic
    const result = converter.convert('not-a-schema', '#/bad');
    expect(result).toBe('z.unknown()');
    expect(diagnostics.list().length).toBeGreaterThanOrEqual(1);
  });

  it('produces diagnostic for empty enum', () => {
    const { converter, diagnostics } = createConverter();
    converter.convert({ enum: [] }, '#/empty');
    expect(diagnostics.list().some((d) => d.code === 'empty-enum')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI 3.1 - type array with 3+ types
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - multi-type arrays (3.1)', () => {
  it('converts type array with three types', () => {
    const { converter } = createConverter();
    const result = converter.convert({ type: ['string', 'number', 'boolean'] }, '#');
    expect(result).toBe('z.union([z.string(), z.number(), z.boolean()])');
  });

  it('converts type array with null and two other types', () => {
    const { converter } = createConverter();
    const result = converter.convert({ type: ['string', 'integer', 'null'] }, '#');
    expect(result).toBe('z.union([z.string(), z.int(), z.null()])');
  });

  it('unwraps single-element type array', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: ['string'] }, '#')).toBe('z.string()');
  });
});

// ---------------------------------------------------------------------------
// Unknown / unsupported string formats
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - unknown string formats', () => {
  it('falls back to z.string() for unrecognised format', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'ipv4' }, '#')).toBe('z.string()');
  });

  it('still applies constraints with unknown format', () => {
    const { converter } = createConverter();
    expect(converter.convert({ type: 'string', format: 'custom', minLength: 1 }, '#')).toBe(
      'z.string().min(1)',
    );
  });
});

// ---------------------------------------------------------------------------
// Const edge cases
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - const edge cases', () => {
  it('converts const: null', () => {
    const { converter } = createConverter();
    expect(converter.convert({ const: null }, '#')).toBe('z.literal(null)');
  });

  it('const takes precedence over type', () => {
    const { converter } = createConverter();
    // Even with type: string, const should be used
    expect(converter.convert({ type: 'string', const: 'fixed' }, '#')).toBe('z.literal("fixed")');
  });
});

// ---------------------------------------------------------------------------
// Enum edge cases
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - enum edge cases', () => {
  it('handles enum with null value', () => {
    const { converter } = createConverter();
    const result = converter.convert({ enum: ['a', null, 'b'] }, '#');
    // Mixed types (strings + null) → union of literals
    expect(result).toBe('z.union([z.literal("a"), z.literal(null), z.literal("b")])');
  });

  it('handles numeric enum', () => {
    const { converter } = createConverter();
    expect(converter.convert({ enum: [1, 2, 3] }, '#')).toBe(
      'z.union([z.literal(1), z.literal(2), z.literal(3)])',
    );
  });
});

// ---------------------------------------------------------------------------
// Nested / complex schemas
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - nested schemas', () => {
  it('converts array of objects', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
      },
      '#',
    );
    expect(result).toContain('z.array(');
    expect(result).toContain('z.object(');
    expect(result).toContain('id: z.int()');
  });

  it('converts nested objects', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
            },
            required: ['street', 'city'],
          },
        },
        required: ['address'],
      },
      '#',
    );
    expect(result).toContain('address: z.object(');
    expect(result).toContain('street: z.string()');
    expect(result).toContain('city: z.string()');
  });

  it('converts array of arrays', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
      },
      '#',
    );
    expect(result).toBe('z.array(z.array(z.number()))');
  });
});

// ---------------------------------------------------------------------------
// Object edge cases
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - object edge cases', () => {
  it('makes all properties optional when required array is absent', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
      },
      '#',
    );
    expect(result).toContain('a: z.string().optional()');
    expect(result).toContain('b: z.number().optional()');
  });

  it('makes all properties required when all are in required', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      '#',
    );
    expect(result).toContain('a: z.string(),');
    expect(result).toContain('b: z.number(),');
    expect(result).not.toContain('optional()');
  });

  it('handles property names with special characters', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          'my-prop': { type: 'string' },
          'has.dot': { type: 'number' },
          'has/slash': { type: 'boolean' },
        },
        required: ['my-prop'],
      },
      '#',
    );
    // Special chars should be quoted
    expect(result).toContain('"my-prop": z.string()');
    expect(result).toContain('"has.dot": z.number()');
    expect(result).toContain('"has/slash": z.boolean()');
  });

  it('handles additionalProperties: true (no-op)', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
        required: ['a'],
      },
      '#',
    );
    // additionalProperties: true is the default — no .strict() or .catchall()
    expect(result).not.toContain('.strict()');
    expect(result).not.toContain('.catchall(');
    expect(result).toContain('a: z.string()');
  });
});

// ---------------------------------------------------------------------------
// Composition edge cases
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - composition edge cases', () => {
  it('converts allOf with three schemas', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'number' } } },
          { type: 'object', properties: { c: { type: 'boolean' } } },
        ],
      },
      '#',
    );
    // Should produce nested intersections
    expect(result).toContain('z.intersection(z.intersection(');
    expect(result).toContain('a: z.string()');
    expect(result).toContain('b: z.number()');
    expect(result).toContain('c: z.boolean()');
  });

  it('converts anyOf with $ref members', () => {
    const { converter } = createConverter({
      componentSchemaVarNames: { Cat: 'CatSchema', Dog: 'DogSchema' },
    });
    const result = converter.convert(
      {
        anyOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
      },
      '#',
    );
    expect(result).toBe('z.union([z.lazy(() => CatSchema), z.lazy(() => DogSchema)])');
  });

  it('converts oneOf with $ref members', () => {
    const { converter } = createConverter({
      componentSchemaVarNames: { A: 'ASchema', B: 'BSchema' },
    });
    const result = converter.convert(
      {
        oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
      },
      '#',
    );
    expect(result).toBe('z.union([z.lazy(() => ASchema), z.lazy(() => BSchema)])');
  });

  it('converts allOf mixing $ref and inline schemas', () => {
    const { converter } = createConverter({
      componentSchemaVarNames: { Base: 'BaseSchema' },
    });
    const result = converter.convert(
      {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { type: 'object', properties: { extra: { type: 'string' } } },
        ],
      },
      '#',
    );
    expect(result).toContain('z.intersection(');
    expect(result).toContain('z.lazy(() => BaseSchema)');
    expect(result).toContain('extra: z.string()');
  });

  it('handles empty anyOf gracefully', () => {
    const { converter } = createConverter();
    // Empty anyOf should not match the anyOf branch (length check)
    const result = converter.convert({ anyOf: [] }, '#');
    expect(result).toBe('z.unknown()');
  });
});

// ---------------------------------------------------------------------------
// Recursive / self-referencing schemas
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - recursive schemas', () => {
  it('handles self-referencing $ref via z.lazy()', () => {
    const { converter } = createConverter({
      componentSchemaVarNames: { TreeNode: 'TreeNodeSchema' },
    });
    // A property that references the same component
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          value: { type: 'string' },
          children: {
            type: 'array',
            items: { $ref: '#/components/schemas/TreeNode' },
          },
        },
        required: ['value'],
      },
      '#',
    );
    expect(result).toContain('value: z.string()');
    expect(result).toContain('z.array(z.lazy(() => TreeNodeSchema))');
  });
});

// ---------------------------------------------------------------------------
// $ref precedence
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - $ref precedence', () => {
  it('$ref takes precedence over type and other keywords', () => {
    const { converter } = createConverter({
      componentSchemaVarNames: { Pet: 'PetSchema' },
    });
    // In OpenAPI 3.1, $ref takes precedence
    const result = converter.convert({ $ref: '#/components/schemas/Pet', type: 'string' }, '#');
    expect(result).toBe('z.lazy(() => PetSchema)');
  });
});

// ---------------------------------------------------------------------------
// useDateCodecs with compositions
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - useDateCodecs with compositions', () => {
  it('emits reference for date-time within anyOf', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    const result = converter.convert(
      { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      '#',
    );
    expect(result).toBe('z.union([isoDatetimeToDate, z.null()])');
  });

  it('emits reference for date-time in array items', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    const result = converter.convert(
      { type: 'array', items: { type: 'string', format: 'date-time' } },
      '#',
    );
    expect(result).toBe('z.array(isoDatetimeToDate)');
  });

  it('emits reference for date-time in object properties', () => {
    const { converter } = createConverter({ useDateCodecs: true });
    const result = converter.convert(
      {
        type: 'object',
        properties: { createdAt: { type: 'string', format: 'date-time' } },
        required: ['createdAt'],
      },
      '#',
    );
    expect(result).toContain('createdAt: isoDatetimeToDate');
  });
});

// ---------------------------------------------------------------------------
// Alphabetize
// ---------------------------------------------------------------------------
describe('SchemaToZodConverter - alphabetical', () => {
  it('preserves original property key order when alphabetical is false', () => {
    const { converter } = createConverter();
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          zebra: { type: 'string' },
          alpha: { type: 'string' },
          mango: { type: 'string' },
        },
        required: ['zebra', 'alpha', 'mango'],
      },
      '#',
    );
    const zebraIndex = result.indexOf('zebra');
    const alphaIndex = result.indexOf('alpha');
    const mangoIndex = result.indexOf('mango');
    expect(zebraIndex).toBeLessThan(alphaIndex);
    expect(alphaIndex).toBeLessThan(mangoIndex);
  });

  it('sorts object property keys alphabetically when alphabetical is true', () => {
    const { converter } = createConverter({ alphabetical: true });
    const result = converter.convert(
      {
        type: 'object',
        properties: {
          zebra: { type: 'string' },
          alpha: { type: 'string' },
          mango: { type: 'string' },
        },
        required: ['zebra', 'alpha', 'mango'],
      },
      '#',
    );
    const zebraIndex = result.indexOf('zebra');
    const alphaIndex = result.indexOf('alpha');
    const mangoIndex = result.indexOf('mango');
    expect(alphaIndex).toBeLessThan(mangoIndex);
    expect(mangoIndex).toBeLessThan(zebraIndex);
  });

  it('preserves original enum value order when alphabetical is false', () => {
    const { converter } = createConverter();
    const result = converter.convert({ type: 'string', enum: ['zebra', 'alpha', 'mango'] }, '#');
    expect(result).toBe('z.enum(["zebra", "alpha", "mango"])');
  });

  it('sorts string enum values alphabetically when alphabetical is true', () => {
    const { converter } = createConverter({ alphabetical: true });
    const result = converter.convert({ type: 'string', enum: ['zebra', 'alpha', 'mango'] }, '#');
    expect(result).toBe('z.enum(["alpha", "mango", "zebra"])');
  });

  it('sorts mixed enum literals alphabetically when alphabetical is true', () => {
    const { converter } = createConverter({ alphabetical: true });
    const result = converter.convert({ enum: [3, 1, 2] }, '#');
    // Sorted by string representation: '1', '2', '3'
    expect(result).toBe('z.union([z.literal(1), z.literal(2), z.literal(3)])');
  });
});
