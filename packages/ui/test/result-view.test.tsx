import type { ReviewResultRow } from '@kakari/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultView } from '../src/components/result-view.tsx';
import { PrLink } from '../src/components/ui.tsx';

afterEach(cleanup);

function row(overrides: Partial<ReviewResultRow>): ReviewResultRow {
  return {
    id: 'r1',
    attempt_id: 'a1',
    job_id: 'j1',
    review_task_id: 't1',
    profile_id: 'default',
    head_sha: 'a'.repeat(40),
    base_sha: null,
    merge_base_sha: null,
    pr_body_hash: null,
    review_config_version: 'v1',
    manual_generation: 0,
    provider: 'claude',
    cli_version: '2.0.0',
    structured: true,
    quality_status: 'complete',
    summary: 's',
    result: null,
    raw_output: null,
    findings_count: 0,
    max_severity: null,
    result_hash: 'h',
    body_deleted_at: null,
    created_at: '2026-09-29T00:00:00Z',
    ...overrides,
  };
}

const malicious =
  '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>';

describe('ResultView', () => {
  it('AI出力に含まれるHTMLを要素として解釈しない（AC-49）', () => {
    // Arrange
    const result = row({
      result: {
        schema_version: 1,
        summary: malicious,
        findings: [
          {
            severity: 'high',
            title: malicious,
            path: 'src/a.ts',
            start_line: 1,
            end_line: 1,
            reason: malicious,
            suggestion: malicious,
            confidence: 'high',
          },
        ],
        questions: [malicious],
        limitations: [],
        quality_status: 'complete',
      },
    });

    // Act
    const { container } = render(<ResultView result={result} />);

    // Assert
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getAllByText(malicious, { exact: false }).length).toBeGreaterThan(0);
  });

  it('構造化できない結果は「要確認」と表示し、指摘0件として扱わない（AC-31）', () => {
    // Act
    render(
      <ResultView
        result={row({ structured: false, quality_status: 'unstructured', raw_output: 'raw text' })}
      />,
    );

    // Assert
    expect(screen.getByText(/要確認/)).toBeTruthy();
    expect(screen.getByText('raw text')).toBeTruthy();
    expect(screen.queryByText('指摘はありません。')).toBeNull();
  });

  it('本文が削除された結果は削除済みと表示する（AC-53）', () => {
    // Act
    render(<ResultView result={row({ body_deleted_at: '2026-09-29T00:00:00Z' })} />);

    // Assert
    expect(screen.getByText(/保存期限により本文を削除しました/)).toBeTruthy();
  });

  it('一部だけの分析で指摘0件なら問題なしとは表示しない', () => {
    // Act
    render(
      <ResultView
        result={row({
          result: {
            schema_version: 1,
            summary: 's',
            findings: [],
            questions: [],
            limitations: ['入力サイズの上限'],
            quality_status: 'partial',
          },
        })}
      />,
    );

    // Assert
    expect(screen.getByText(/問題なしとは限りません/)).toBeTruthy();
  });
});

describe('PrLink', () => {
  it('GitHubのPR形式のURLだけをリンクにする', () => {
    // Act
    const { container } = render(<PrLink url="javascript:alert(1)" host="github.com" />);

    // Assert
    expect(container.querySelector('a')).toBeNull();
  });

  it('リンク先のURLを表示する（11.6）', () => {
    // Act
    render(<PrLink url="https://github.com/o/r/pull/1" host="github.com" />);

    // Assert
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('(https://github.com/o/r/pull/1)')).toBeTruthy();
  });
});
