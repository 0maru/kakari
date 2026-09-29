import { z } from 'zod';

// 8.4 正規化する結果
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;

export const findingSchema = z.object({
  severity: z.enum(SEVERITIES),
  title: z.string().min(1).max(300),
  path: z.string().max(1000).nullable(),
  start_line: z.number().int().positive().nullable(),
  end_line: z.number().int().positive().nullable(),
  reason: z.string().max(8000),
  suggestion: z.string().max(8000).nullable(),
  confidence: z.enum(CONFIDENCES),
});

export type Finding = z.infer<typeof findingSchema>;

export const reviewResultSchema = z.object({
  schema_version: z.literal(1),
  summary: z.string().max(4000),
  findings: z.array(findingSchema).max(200),
  questions: z.array(z.string().max(4000)).max(100),
  limitations: z.array(z.string().max(4000)).max(100),
  quality_status: z.enum(['complete', 'partial']),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

/**
 * AI CLI へ渡す出力形式（JSON Schema）。
 * 構造化出力の検証に使う。zod 側の定義と同じ形を保つ。
 */
export const reviewResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'summary', 'findings', 'questions', 'limitations', 'quality_status'],
  properties: {
    schema_version: { type: 'integer', enum: [1] },
    summary: { type: 'string', maxLength: 4000 },
    findings: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'title',
          'path',
          'start_line',
          'end_line',
          'reason',
          'suggestion',
          'confidence',
        ],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          path: { type: ['string', 'null'], maxLength: 1000 },
          start_line: { type: ['integer', 'null'], minimum: 1 },
          end_line: { type: ['integer', 'null'], minimum: 1 },
          reason: { type: 'string', maxLength: 8000 },
          suggestion: { type: ['string', 'null'], maxLength: 8000 },
          confidence: { type: 'string', enum: [...CONFIDENCES] },
        },
      },
    },
    questions: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 4000 } },
    limitations: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 4000 } },
    quality_status: { type: 'string', enum: ['complete', 'partial'] },
  },
} as const;

export type QualityStatus = 'complete' | 'partial' | 'unstructured';

export interface NormalizedResult {
  structured: boolean;
  qualityStatus: QualityStatus;
  summary: string | null;
  result: ReviewResult | null;
  findingsCount: number | null;
  maxSeverity: Severity | null;
}

export function maxSeverityOf(findings: readonly Finding[]): Severity | null {
  let best: Severity | null = null;
  for (const f of findings) {
    if (best === null || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(best)) {
      best = f.severity;
    }
  }
  return best;
}

/**
 * AIの出力を正規化する。解析できない場合は `unstructured` とし、指摘0件として扱わない（8.4・AC-31）。
 * AIに整形の再依頼はしない。
 */
export function normalizeReviewOutput(value: unknown): NormalizedResult {
  const parsed = reviewResultSchema.safeParse(value);
  if (!parsed.success) {
    return {
      structured: false,
      qualityStatus: 'unstructured',
      summary: null,
      result: null,
      findingsCount: null,
      maxSeverity: null,
    };
  }
  const result = parsed.data;
  return {
    structured: true,
    qualityStatus: result.quality_status,
    summary: result.summary,
    result,
    findingsCount: result.findings.length,
    maxSeverity: maxSeverityOf(result.findings),
  };
}
