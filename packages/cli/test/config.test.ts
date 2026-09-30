import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseConfig, parseLocal } from '../src/config/load.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const example = () => parse(readFileSync(`${root}config.example.yaml`, 'utf8'));

describe('config.yaml', () => {
  it('設定例を読み込める', () => {
    // Act
    const config = parseConfig(example());

    // Assert
    expect(config.profiles[0]?.id).toBe('default');
    expect(config.profiles[0]?.enabled).toBe(false);
  });

  it('local.yaml の設定例を読み込める', () => {
    // Act
    const local = parseLocal(parse(readFileSync(`${root}local.example.yaml`, 'utf8')));

    // Assert
    expect(local.secrets['default-github']).toBe('gh-account:example-user');
  });

  it('未定義の設定キーはエラーにする（15章）', () => {
    // Arrange
    const raw = example();
    raw.profiles[0].review.unknown_key = true;

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow(/unknown_key|Unrecognized/);
  });

  it('未定義の参照はエラーにする', () => {
    // Arrange
    const raw = example();
    raw.profiles[0].review.usage_pool_id = 'missing-pool';
    raw.profiles[0].notifications.destination_worker_id = 'missing-worker';

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow(/missing-pool[\s\S]*missing-worker/);
  });

  it('送信許可のないプロファイルは有効化できない（14.2）', () => {
    // Arrange
    const raw = example();
    raw.profiles[0].enabled = true;

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow(/send_to_provider_approved/);
  });

  it('未実装のproviderはエラーにする', () => {
    // Arrange
    const raw = example();
    raw.usage_pools.push({ id: 'codex-plan', provider: 'codex' });
    raw.profiles[0].review.provider = 'codex';
    raw.profiles[0].review.usage_pool_id = 'codex-plan';

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow(/未実装/);
  });

  it('APIキーへのフォールバックは設定できない（5.4）', () => {
    // Arrange
    const raw = example();
    raw.profiles[0].review.allow_paid_api_fallback = true;

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow();
  });

  it('同じPRに重複マッチするプロファイルはエラーにする（5.1）', () => {
    // Arrange
    const raw = example();
    const copy = structuredClone(raw.profiles[0]);
    copy.id = 'second';
    raw.profiles.push(copy);
    raw.workers[0].allowed_profiles.push('second');
    raw.workers[1].allowed_profiles.push('second');

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow(/重複してマッチ/);
  });

  it('対象リポジトリを分けたプロファイルは重複とみなさない', () => {
    // Arrange
    const raw = example();
    raw.profiles[0].github.include_repositories = ['example-org/app'];
    const copy = structuredClone(raw.profiles[0]);
    copy.id = 'second';
    copy.github.include_repositories = ['example-org/api'];
    raw.profiles.push(copy);
    raw.workers[0].allowed_profiles.push('second');
    raw.workers[1].allowed_profiles.push('second');

    // Act / Assert
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it('notifier と他の役割を同じworkerに持たせない（13.3）', () => {
    // Arrange
    const raw = example();
    raw.workers[0].roles.push('notifier');

    // Act / Assert
    expect(() => parseConfig(raw)).toThrow(/notifier/);
  });

  it('資格情報の参照先は決められた書式だけを受け付ける', () => {
    // Act / Assert
    expect(() => parseLocal({ schema_version: 1, secrets: { a: 'ghp_rawtoken' } })).toThrow();
  });
});
