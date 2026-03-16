/**
 * OpenAPI-to-Zod source code generator.
 *
 * Orchestrates the full pipeline: parsing an OpenAPI document, extracting an
 * intermediate model, and emitting TypeScript source code with Zod schemas
 * for every path operation and component schema.
 *
 * @module generator
 */

import type { IJsonSchema } from '@scalar/openapi-types';
import { PathItemObjectSchema } from '@scalar/openapi-types/schemas/3.1/unprocessed';
import type {
  GenerateZodSourceOptions,
  GenerateZodSourceResult,
  OpenApiObject,
  ExtractedModel,
  ExtractedPathOperation,
  ParameterObject,
  PlainObject,
  RequestBodyObject,
  ResponseObject,
  SchemaOverrideContext,
} from './types';
import { DiagnosticCollector } from './diagnostics-collector';
import { SchemaToZodConverter } from './schema-to-zod-converter';
import {
  ensureObject,
  ensureSchema,
  escapeJsonPointer,
  isObject,
  normalizeParameters,
  normalizeRequestBody,
  normalizeResponse,
  sortKeys,
  toIdentifier,
  toPropertyKey,
  topoSortSchemaNames,
  unescapeJsonPointer,
} from './json-schema-utils';

/**
 * Generates TypeScript source code containing Zod schemas from an
 * OpenAPI 3.x document.
 *
 * The returned source exports a `schemas` constant with path operations
 * (parameters, request bodies, responses) and component schemas.
 *
 * @param openApiObject - A parsed OpenAPI 3.x document.
 * @param options - Generation options (defaults to strict mode).
 * @returns The generated source code and any diagnostics.
 *
 * @example
 * ```ts
 * const { code, diagnostics } = await generateZodSourceFromOpenApi(spec);
 * await Bun.write('schemas.ts', code);
 * ```
 */
export async function generateZodSourceFromOpenApi(
  openApiObject: OpenApiObject,
  options: GenerateZodSourceOptions = {},
): Promise<GenerateZodSourceResult> {
  const diagnostics = new DiagnosticCollector(options.strict ?? true);
  const model = extractModel(openApiObject, diagnostics);
  const code = emitSource(model, openApiObject, diagnostics, options);

  return {
    code,
    diagnostics: diagnostics.list(),
  };
}

/**
 * Walks the OpenAPI document and builds an {@link ExtractedModel}
 * intermediate representation that the emitter can consume.
 *
 * Iterates over every path item and HTTP method, normalising parameters,
 * request bodies, and responses into flat schema maps.
 *
 * @param openApiObject - The root OpenAPI document.
 * @param diagnostics - Collector for issues found during extraction.
 * @returns The extracted model.
 */
function extractModel(
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
): ExtractedModel {
  const paths: Record<string, Record<string, ExtractedPathOperation>> = {};

  const root = openApiObject;
  const rootPaths = ensureObject(root.paths, '#/paths', diagnostics) ?? {};

  for (const pathKey of sortKeys(rootPaths)) {
    const pathItemPointer = `#/paths/${escapeJsonPointer(pathKey)}`;
    const pathItemResult = PathItemObjectSchema.safeParse(rootPaths[pathKey] ?? {});
    if (!pathItemResult.success) {
      diagnostics.push(
        'invalid-path-item',
        `Path item validation failed: ${pathItemResult.error.issues.map((i) => i.message).join(', ')}`,
        pathItemPointer,
      );
      continue;
    }
    const pathItemObj = pathItemResult.data;
    const pathParameters = normalizeParameters(
      pathItemObj.parameters,
      `${pathItemPointer}/parameters`,
      root,
      diagnostics,
    );

    const methods: Record<string, ExtractedPathOperation> = {};

    for (const method of [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'options',
      'head',
      'trace',
    ] as const) {
      const operationValue = pathItemObj[method];
      if (!isObject(operationValue)) {
        continue;
      }

      const operationPointer = `#/paths/${escapeJsonPointer(pathKey)}/${method}`;
      const operation = operationValue;

      const operationParameters = normalizeParameters(
        operation.parameters,
        `${operationPointer}/parameters`,
        root,
        diagnostics,
      );
      const mergedParameters = mergeParameters(pathParameters, operationParameters);

      // Path parameters (individual schemas)
      const pathParams: Record<string, PlainObject> = {};
      for (const param of mergedParameters.filter((p) => p.in === 'path')) {
        pathParams[param.name] = getParameterSchema(
          param,
          `${operationPointer}/parameters`,
          diagnostics,
        );
      }

      // Query parameters (individual schemas)
      const queryParams: Record<string, PlainObject> = {};
      for (const param of mergedParameters.filter((p) => p.in === 'query')) {
        queryParams[param.name] = getParameterSchema(
          param,
          `${operationPointer}/parameters`,
          diagnostics,
        );
      }

      // Request body (by media type)
      let requestBody: Record<string, PlainObject> | undefined;
      if (operation.requestBody !== undefined) {
        const rb = normalizeRequestBody(
          operation.requestBody,
          `${operationPointer}/requestBody`,
          root,
          diagnostics,
        );
        const contentSchemas = extractContentSchemas(
          rb.content,
          `${operationPointer}/requestBody/content`,
          diagnostics,
        );
        if (Object.keys(contentSchemas).length > 0) {
          requestBody = contentSchemas;
        }
      }

      // Responses (statusCode -> primary schema)
      const responses: Record<string, PlainObject> = {};
      const operationResponses = isObject(operation.responses) ? operation.responses : {};

      for (const statusCode of sortKeys(operationResponses)) {
        const response = normalizeResponse(
          operationResponses[statusCode],
          `${operationPointer}/responses/${statusCode}`,
          root,
          diagnostics,
        );
        const contentSchemas = extractContentSchemas(
          response.content,
          `${operationPointer}/responses/${statusCode}/content`,
          diagnostics,
        );
        // Prefer application/json, fall back to first media type
        const jsonSchema = contentSchemas['application/json'];
        if (jsonSchema) {
          responses[statusCode] = jsonSchema;
        } else {
          const firstKey = Object.keys(contentSchemas)[0];
          if (firstKey && contentSchemas[firstKey]) {
            responses[statusCode] = contentSchemas[firstKey];
          }
        }
      }

      methods[method] = {
        path: pathParams,
        query: queryParams,
        ...(requestBody ? { requestBody } : {}),
        responses,
      };
    }

    if (Object.keys(methods).length > 0) {
      paths[pathKey] = methods;
    }
  }

  // Component schemas
  const componentSchemas: Record<string, PlainObject> = {};
  const components = ensureObject(root.components ?? {}, '#/components', diagnostics);
  const schemas = ensureObject(components.schemas ?? {}, '#/components/schemas', diagnostics);
  for (const schemaName of sortKeys(schemas)) {
    componentSchemas[schemaName] =
      ensureSchema(
        schemas[schemaName],
        `#/components/schemas/${escapeJsonPointer(schemaName)}`,
        diagnostics,
      ) ?? {};
  }

  return {
    paths,
    components: {
      schemas: componentSchemas,
    },
  };
}

/**
 * Emits the TypeScript source string from the extracted model.
 *
 * Produces an auto-generated header, a Zod import, component schema
 * variables (for `z.lazy` cross-references), and the `schemas` constant
 * containing every path operation and component.
 *
 * @param model - The intermediate model to emit.
 * @param openApiObject - The original OpenAPI document (for ref resolution).
 * @param diagnostics - Collector for emission issues.
 * @returns The complete TypeScript source string.
 */
function emitSource(
  model: ExtractedModel,
  openApiObject: OpenApiObject,
  diagnostics: DiagnosticCollector,
  options: GenerateZodSourceOptions = {},
): string {
  const componentSchemaVarNames = buildComponentSchemaVarNames(model.components.schemas);
  const converter = new SchemaToZodConverter(
    openApiObject,
    componentSchemaVarNames,
    diagnostics,
    options.useDateCodecs ?? false,
    options.overrides ?? {},
    options.overrideCallback,
    options.strictAdditionalProperties ?? true,
    options.alphabetical ?? false,
  );

  // Collect body lines first so we know which codecs were used before assembling the header
  const bodyLines: string[] = [];

  // Emit component schema variables in dependency-first order so that direct
  // variable references (no z.lazy) are always declared before use.
  const componentSchemaOrder = topoSortSchemaNames(model.components.schemas, (ref) => {
    const m = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
    return m ? unescapeJsonPointer(m[1] ?? '') : undefined;
  });
  for (const schemaName of componentSchemaOrder) {
    const schemaVarName = componentSchemaVarNames[schemaName];
    const schemaExpr = converter.convert(
      model.components.schemas[schemaName],
      `#/components/schemas/${escapeJsonPointer(schemaName)}`,
    );
    bodyLines.push(`const ${schemaVarName} = ${schemaExpr};`);
  }

  if (componentSchemaOrder.length > 0) {
    bodyLines.push('');
  }

  // Paths
  bodyLines.push('export const paths = {');
  for (const pathKey of sortKeys(model.paths)) {
    const methods = model.paths[pathKey];
    if (!methods) continue;
    bodyLines.push(`  ${toPropertyKey(pathKey)}: {`);
    for (const method of sortKeys(methods)) {
      const op = methods[method];
      if (!op) continue;
      bodyLines.push(`    ${method}: {`);

      // Path parameters
      const pathParamsPointer = `#/paths/${escapeJsonPointer(pathKey)}/${method}/pathParams`;
      const pathParamsOverride = resolveGroupOverride(
        pathParamsPointer,
        'path-params',
        op.path,
        options,
        converter,
        `#/paths/${escapeJsonPointer(pathKey)}/${method}/parameters`,
      );
      if (pathParamsOverride !== undefined) {
        bodyLines.push(`      path: ${pathParamsOverride},`);
      } else {
        bodyLines.push('      path: z.object({');
        for (const paramName of sortKeys(op.path)) {
          const expr = converter.convert(
            op.path[paramName],
            `#/paths/${escapeJsonPointer(pathKey)}/${method}/parameters/${escapeJsonPointer(paramName)}/schema`,
          );
          bodyLines.push(`        ${toPropertyKey(paramName)}: ${expr},`);
        }
        bodyLines.push('      }),');
      }

      // Query parameters
      const queryParamsPointer = `#/paths/${escapeJsonPointer(pathKey)}/${method}/queryParams`;
      const queryParamsOverride = resolveGroupOverride(
        queryParamsPointer,
        'query-params',
        op.query,
        options,
        converter,
        `#/paths/${escapeJsonPointer(pathKey)}/${method}/parameters`,
      );
      if (queryParamsOverride !== undefined) {
        bodyLines.push(`      query: ${queryParamsOverride},`);
      } else {
        bodyLines.push('      query: z.object({');
        for (const paramName of sortKeys(op.query)) {
          const expr = converter.convert(
            op.query[paramName],
            `#/paths/${escapeJsonPointer(pathKey)}/${method}/parameters/${escapeJsonPointer(paramName)}/schema`,
          );
          bodyLines.push(`        ${toPropertyKey(paramName)}: ${expr},`);
        }
        bodyLines.push('      }),');
      }

      // Request body
      if (op.requestBody) {
        const requestBodyPointer = `#/paths/${escapeJsonPointer(pathKey)}/${method}/requestBody`;
        const requestBodyOverride = resolveGroupOverride(
          requestBodyPointer,
          'request-body',
          op.requestBody,
          options,
          converter,
          requestBodyPointer,
        );
        if (requestBodyOverride !== undefined) {
          bodyLines.push(`      requestBody: ${requestBodyOverride},`);
        } else {
          bodyLines.push('      requestBody: {');
          for (const mediaType of sortKeys(op.requestBody)) {
            const expr = converter.convert(
              op.requestBody[mediaType],
              `#/paths/${escapeJsonPointer(pathKey)}/${method}/requestBody/content/${escapeJsonPointer(mediaType)}/schema`,
            );
            bodyLines.push(`        ${toPropertyKey(mediaType)}: ${expr},`);
          }
          bodyLines.push('      },');
        }
      }

      // Responses
      const responsesPointer = `#/paths/${escapeJsonPointer(pathKey)}/${method}/responses`;
      const responsesOverride = resolveGroupOverride(
        responsesPointer,
        'responses',
        op.responses,
        options,
        converter,
        responsesPointer,
      );
      if (responsesOverride !== undefined) {
        bodyLines.push(`      responses: ${responsesOverride},`);
      } else {
        bodyLines.push('      responses: {');
        for (const statusCode of sortKeys(op.responses)) {
          const expr = converter.convert(
            op.responses[statusCode],
            `#/paths/${escapeJsonPointer(pathKey)}/${method}/responses/${statusCode}/content/schema`,
          );
          bodyLines.push(`        ${toPropertyKey(statusCode)}: ${expr},`);
        }
        bodyLines.push('      },');
      }

      bodyLines.push('    },');
    }
    bodyLines.push('  },');
  }
  bodyLines.push('} as const;');

  bodyLines.push('');

  // Components
  bodyLines.push('export const components = {');
  bodyLines.push('  schemas: {');
  for (const schemaName of sortKeys(model.components.schemas)) {
    bodyLines.push(`    ${toPropertyKey(schemaName)}: ${componentSchemaVarNames[schemaName]},`);
  }
  bodyLines.push('  },');

  bodyLines.push('} as const;');

  const headerLines: string[] = [];
  headerLines.push('// Auto-generated by @saunos/openapi-to-zod.');
  headerLines.push("import { z } from 'zod';");

  const usedCodecs = converter.getUsedCodecs();
  if (usedCodecs.size > 0) {
    headerLines.push('');
    if (usedCodecs.has('datetime')) {
      headerLines.push(
        'const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), { decode: (isoString) => new Date(isoString), encode: (date) => date.toISOString() });',
      );
    }
    if (usedCodecs.has('date')) {
      headerLines.push(
        'const isoDateToDate = z.codec(z.iso.date(), z.date(), { decode: (isoString) => new Date(isoString), encode: (date) => date.toISOString().slice(0, 10) });',
      );
    }
  }

  headerLines.push('');

  return `${[...headerLines, ...bodyLines].join('\n')}\n`;
}

/**
 * Extracts the JSON Schema from an OpenAPI Parameter Object.
 *
 * Looks first at the top-level `schema` field, then falls back to the
 * first entry in `content`. Emits a diagnostic if neither is present.
 *
 * @param parameter - The validated parameter object.
 * @param pointer - JSON Pointer for diagnostics.
 * @param diagnostics - Collector for missing-schema warnings.
 * @returns The parameter's schema, or `{}` if none was found.
 */
function getParameterSchema(
  parameter: ParameterObject,
  pointer: string,
  diagnostics: DiagnosticCollector,
): PlainObject {
  if (parameter.schema && isObject(parameter.schema)) {
    return parameter.schema;
  }

  if (parameter.content) {
    const contentTypes = sortKeys(parameter.content);
    const firstType = contentTypes[0];
    if (firstType) {
      const mediaType = parameter.content[firstType];
      if (mediaType && isObject(mediaType.schema)) {
        return mediaType.schema;
      }
    }
  }

  diagnostics.push(
    'missing-parameter-schema',
    `Parameter "${parameter.name}" is missing schema/content`,
    pointer,
  );
  return {};
}

/**
 * Extracts schemas from an OpenAPI Media Type map.
 *
 * Iterates over each media-type entry (e.g. `"application/json"`) and
 * pulls out its `schema`. Media types without a schema generate a diagnostic.
 *
 * @param content - The `content` map from a Request Body or Response Object.
 * @param pointer - JSON Pointer to the content location.
 * @param diagnostics - Collector for issues.
 * @returns A map from media type string to its JSON Schema.
 */
function extractContentSchemas(
  content: RequestBodyObject['content'] | ResponseObject['content'] | undefined,
  pointer: string,
  diagnostics: DiagnosticCollector,
): Record<string, PlainObject> {
  if (!content) {
    return {};
  }

  const result: Record<string, PlainObject> = {};
  for (const mediaType of sortKeys(content)) {
    const mediaTypeObject = content[mediaType];
    if (!mediaTypeObject || !isObject(mediaTypeObject.schema)) {
      diagnostics.push(
        'missing-media-schema',
        `Media type "${mediaType}" does not have a schema`,
        `${pointer}/${escapeJsonPointer(mediaType)}`,
        'warning',
      );
      continue;
    }
    result[mediaType] = mediaTypeObject.schema;
  }
  return result;
}

/**
 * Merges path-level and operation-level parameters.
 *
 * Operation parameters override path-level ones that share the same
 * `in` + `name` combination (as per the OpenAPI specification).
 * The result is sorted by merge key for deterministic output.
 *
 * @param pathParameters - Parameters declared on the path item.
 * @param operationParameters - Parameters declared on the operation.
 * @returns Deduplicated, sorted array of parameters.
 */
function mergeParameters(
  pathParameters: ParameterObject[],
  operationParameters: ParameterObject[],
): ParameterObject[] {
  const merged = new Map<string, ParameterObject>();

  for (const parameter of pathParameters) {
    merged.set(parameterMergeKey(parameter), parameter);
  }
  for (const parameter of operationParameters) {
    merged.set(parameterMergeKey(parameter), parameter);
  }

  return Array.from(merged.values()).sort((a, b) =>
    parameterMergeKey(a).localeCompare(parameterMergeKey(b)),
  );
}

/**
 * Creates a stable composite key for deduplicating parameters.
 *
 * @param parameter - A parameter object.
 * @returns A string in the form `"in:name"` (e.g. `"query:limit"`).
 *
 * @example
 * ```ts
 * parameterMergeKey({ name: 'limit', in: 'query' }); // => 'query:limit'
 * parameterMergeKey({ name: 'petId', in: 'path' });   // => 'path:petId'
 * ```
 */
function parameterMergeKey(parameter: ParameterObject): string {
  return `${parameter.in}:${parameter.name}`;
}

/**
 * Assigns unique TypeScript variable names to component schemas.
 *
 * Each schema name is converted to a valid identifier via
 * {@link toIdentifier} and suffixed with `Schema`. Collisions are
 * resolved by appending an incrementing number.
 *
 * @param componentSchemas - Map of component schema name to its JSON Schema.
 * @returns Map of component schema name to its generated variable name.
 *
 * @example
 * ```ts
 * buildComponentSchemaVarNames({ Pet: { type: 'object' }, Error: { type: 'object' } });
 * // => { Pet: 'PetSchema', Error: 'ErrorSchema' }
 * ```
 */
function buildComponentSchemaVarNames(
  componentSchemas: Record<string, IJsonSchema>,
): Record<string, string> {
  const used = new Set<string>();
  const mapping: Record<string, string> = {};

  for (const name of sortKeys(componentSchemas)) {
    const base = `${toIdentifier(name)}Schema`;
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${base}${index}`;
      index += 1;
    }
    used.add(candidate);
    mapping[name] = candidate;
  }

  return mapping;
}

/**
 * Checks whether a group-level pointer has an override (static or via callback).
 *
 * Used for path params, query params, request body, and responses groups.
 * When a static `overrides` entry exists for the pointer it takes precedence.
 * Otherwise the `overrideCallback` is invoked with a generated expression
 * built by converting each member individually and assembling a `{ key: expr }`
 * object literal.
 *
 * @returns The override expression string, or `undefined` if no override applies.
 */
function resolveGroupOverride(
  pointer: string,
  kind: SchemaOverrideContext['kind'],
  schemas: Record<string, PlainObject>,
  options: GenerateZodSourceOptions,
  converter: SchemaToZodConverter,
  memberPointerBase: string,
): string | undefined {
  // Static override takes precedence
  if (options.overrides && pointer in options.overrides) {
    return options.overrides[pointer];
  }

  // If no callback, nothing to do
  if (!options.overrideCallback) {
    return undefined;
  }

  // Build the default generated expression so the callback can inspect it
  const entries = sortKeys(schemas).map((key) => {
    const expr = converter.convert(
      schemas[key],
      `${memberPointerBase}/${escapeJsonPointer(key)}/schema`,
    );
    return `  ${toPropertyKey(key)}: ${expr},`;
  });
  const generatedExpression = entries.length === 0 ? '{}' : `{\n${entries.join('\n')}\n}`;

  return options.overrideCallback({
    pointer,
    schema: schemas,
    kind,
    type: undefined,
    generatedExpression,
  });
}
