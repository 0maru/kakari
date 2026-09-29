import { describe, expect, it } from 'vitest';
import {
  describeWaitingReason,
  maxSeverityOf,
  normalizeReviewOutput,
  toKakariError,
} from '../src/index.ts';

const valid = {
  schema_version: 1,
  summary: '要約',
  findings: [
    {
      severity: 'low',
      title: 'a',
      path: null,
      start_line: null,
      end_line: null,
      reason: 'r',
      suggestion: null,
      confidence: 'low',
    },
    {
      severity: 'critical',
      title: 'b',
      path: 'x.ts',
      start_line: 1,
      end_line: 2,
      reason: 'r',
      suggestion: 's',
      confidence: 'high',
    },
  ],
  questions: [],
  limitations: [],
  quality_status: 'complete',
};

describe('normalizeReviewOutput', () => {
  it('スキーマどおりの結果を構造化して最大重要度を求める', () => {
    // Act
    const res = normalizeReviewOutput(valid);

    // Assert
    expect(res).toMatchObject({
      structured: true,
      qualityStatus: 'complete',
      findingsCount: 2,
      maxSeverity: 'critical',
    });
  });

  it('スキーマに合わない出力は unstructured にし、指摘0件として扱わない（AC-31）', () => {
    // Act
    const res = normalizeReviewOutput({ ...valid, findings: 'none' });

    // Assert
    expect(res).toMatchObject({
      structured: false,
      qualityStatus: 'unstructured',
      findingsCount: null,
    });
  });

  it('指摘がなければ最大重要度は null', () => {
    // Act / Assert
    expect(maxSeverityOf([])).toBeNull();
  });
});

describe('describeWaitingReason', () => {
  it.each([
    ['github_rate_limited', 'GitHubのレート制限で同期を保留中'],
    ['job_blocked:usage_limit', '利用上限に到達したため保留中'],
    ['job_unknown:lease_expired', '実行結果が不明です（照合が必要）'],
    ['job_failed:weird', 'AIレビューに失敗しました（weird）'],
  ])('%s', (reason, expected) => {
    expect(describeWaitingReason(reason)).toBe(expected);
  });
});

describe('toKakariError', () => {
  it('DB関数の権限エラーを forbidden に分類し接頭辞を外す', () => {
    // Act
    const e = toKakariError({ code: '42501', message: 'kakari: forbidden' });

    // Assert
    expect(e.kind).toBe('forbidden');
    expect(e.message).toBe('forbidden');
  });

  it('通信エラーを network に分類する', () => {
    // Act / Assert
    expect(toKakariError(new TypeError('fetch failed')).kind).toBe('network');
  });
});
