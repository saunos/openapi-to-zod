import type { GeneratorDiagnostic } from './types';

/**
 * Collects {@link GeneratorDiagnostic} messages produced during OpenAPI
 * processing and code generation.
 *
 * In **strict** mode, an error-level diagnostic immediately throws,
 * aborting generation. In non-strict mode all diagnostics are silently
 * accumulated and can be retrieved after generation completes.
 *
 * @example
 * ```ts
 * const diag = new DiagnosticCollector(false);
 * diag.push('missing-ref', 'Ref not found', '#/paths/~1pets');
 * diag.list(); // => [{ code: 'missing-ref', message: 'Ref not found', pointer: '#/paths/~1pets', level: 'error' }]
 * ```
 */
export class DiagnosticCollector {
  /** Internal store of accumulated diagnostics. */
  private readonly diagnostics: GeneratorDiagnostic[] = [];

  /**
   * @param strict - When `true`, error-level diagnostics throw immediately.
   */
  constructor(private readonly strict: boolean) {}

  /**
   * Records a new diagnostic.
   *
   * @param code - Machine-readable identifier (e.g. `"invalid-ref"`).
   * @param message - Human-readable description of the problem.
   * @param pointer - JSON Pointer to the offending location in the spec.
   * @param level - Severity; defaults to `"error"`.
   * @throws {Error} If `strict` is `true` and `level` is `"error"`.
   *
   * @example
   * ```ts
   * collector.push('invalid-ref', 'Cannot resolve ref', '#/components/schemas/Pet');
   * collector.push('unused-param', 'Param not referenced', '#/paths/~1pets', 'warning');
   * ```
   */
  push(code: string, message: string, pointer: string, level: 'error' | 'warning' = 'error'): void {
    const diagnostic: GeneratorDiagnostic = { code, message, pointer, level };
    this.diagnostics.push(diagnostic);

    if (this.strict && level === 'error') {
      throw new Error(`[${code}] ${message} at ${pointer}`);
    }
  }

  /**
   * Returns all diagnostics collected so far.
   *
   * @returns A snapshot array of {@link GeneratorDiagnostic} entries.
   */
  list(): GeneratorDiagnostic[] {
    return this.diagnostics;
  }
}
