#!/usr/bin/env node
/**
 * CLI entry point for the OpenAPI-to-Zod code generator.
 *
 * Usage:
 *   openapi-to-zod [inputPath] [outputPath] [--use-date-codecs] [--alphabetical]
 *                  [--no-strict] [--no-strict-additional-properties]
 *                  [--override pointer=expr ...]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GenerateZodSourceOptions, GenerateJsonSchemaZodSourceOptions } from './src/index.ts';
import { generateZodSourceFromOpenApi, generateZodSourceFromJsonSchema } from './src/index.ts';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    `
openapi-to-zod — Generate Zod schemas from an OpenAPI spec.

USAGE
  openapi-to-zod [inputPath] [outputPath] [options]

ARGUMENTS
  inputPath    Path or URL to the OpenAPI JSON file.
  outputPath   Path for the generated TypeScript file. (default: stdout)

OPTIONS
  --json-schema                    Treat the input as a plain JSON Schema
                                   document (with $defs) instead of an
                                   OpenAPI spec. Emits "schema" and "defs"
                                   exports rather than "paths"/"components".
  --use-date-codecs                Emit z.codec(...) for date and date-time
                                   string formats, converting between ISO
                                   strings and Date objects.
  --alphabetical                   Sort object property keys and enum values
                                   alphabetically in the generated Zod
                                   expressions.
  --no-strict                      Collect all error-level diagnostics instead
                                   of throwing on the first one.
  --no-strict-additional-properties
                                   Do not append .strict() to objects that
                                   declare additionalProperties: false. Useful
                                   when the API may return undocumented fields.
  --override pointer=expr          Replace the auto-generated Zod expression at
                                   the given JSON Pointer with a custom
                                   expression. Can be specified multiple times.
  -h, --help                       Show this help message and exit.

OVERRIDE POINTER PATTERNS
  Schema-level (replaces a single schema node):
    #/components/schemas/MyModel
    #/components/schemas/MyModel/properties/myField
    #/paths/~1pets/get/parameters/petId/schema
    #/paths/~1pets/get/parameters/limit/schema
    #/paths/~1pets/get/responses/200/content/schema

  Group-level (replaces an entire parameter/response group):
    #/paths/~1pets/get/pathParams
    #/paths/~1pets/get/queryParams
    #/paths/~1pets/post/requestBody
    #/paths/~1pets/get/responses

EXAMPLES
  openapi-to-zod
  openapi-to-zod ./spec.json ./out/schemas.ts --use-date-codecs
  openapi-to-zod https://petstore3.swagger.io/api/v3/openapi.json ./out/schemas.ts
  openapi-to-zod api.json out.ts --override "#/components/schemas/Date=z.coerce.date()"
  openapi-to-zod api.json out.ts --override "#/components/schemas/Date=z.coerce.date()" \\
                                 --override "#/paths/~1pets/get/queryParams=petsQuerySchema"
  openapi-to-zod api.json out.ts --alphabetical
  openapi-to-zod api.json out.ts --no-strict --no-strict-additional-properties
`.trimStart(),
  );
  process.exit(0);
}

// Collect flags and their values, then extract positional args
const flagValueIndices = new Set<number>();
const useDateCodecs = args.includes('--use-date-codecs');
const alphabetical = args.includes('--alphabetical');
const strict = !args.includes('--no-strict');
const strictAdditionalProperties = !args.includes('--no-strict-additional-properties');
const jsonSchemaMode = args.includes('--json-schema');

// Parse --override pointer=expr pairs
const overrides: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--override' && i + 1 < args.length) {
    flagValueIndices.add(i);
    flagValueIndices.add(i + 1);
    const value = args[++i]!;
    const eqIndex = value.indexOf('=');
    if (eqIndex > 0) {
      overrides[value.slice(0, eqIndex)] = value.slice(eqIndex + 1);
    }
  }
}

const positionalArgs = args.filter((arg, i) => !arg.startsWith('--') && !flagValueIndices.has(i));
const inputPath = positionalArgs[0];

if (!inputPath) {
  console.error('Error: inputPath is required. Use --help for usage information.');
  process.exit(1);
}

const outputPath = positionalArgs[1] ?? null;

const isUrl = inputPath.startsWith('http://') || inputPath.startsWith('https://');
const inputObject = isUrl
  ? await fetch(inputPath).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${inputPath}`);
      return res.json();
    })
  : JSON.parse(await readFile(inputPath, 'utf8'));

const result = jsonSchemaMode
  ? generateZodSourceFromJsonSchema(inputObject, {
      strict,
      useDateCodecs,
      alphabetical,
      strictAdditionalProperties,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    } satisfies GenerateJsonSchemaZodSourceOptions)
  : await generateZodSourceFromOpenApi(inputObject, {
      strict,
      useDateCodecs,
      alphabetical,
      strictAdditionalProperties,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    } satisfies GenerateZodSourceOptions);

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.code, 'utf8');
  console.log(`Generated Zod source written to ${outputPath}`);
} else {
  process.stdout.write(result.code);
}
if (result.diagnostics.length > 0) {
  console.error(`Diagnostics: ${result.diagnostics.length}`);
}
