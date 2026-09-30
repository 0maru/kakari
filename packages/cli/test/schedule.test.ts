import { describe, expect, it } from 'vitest';
import { latestDueSlot, zonedTimeToUtc } from '../src/notify/schedule.ts';

const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('zonedTimeToUtc', () => {
  it('Asia/Tokyo の壁時計時刻をUTCへ変換する', () => {
    // Act
    const ts = zonedTimeToUtc(2026, 9, 29, 11, 0, 'Asia/Tokyo');

    // Assert
    expect(new Date(ts).toISOString()).toBe('2026-09-29T02:00:00.000Z');
  });

  it('夏時間のタイムゾーンでも変換する', () => {
    // Act
    const summer = zonedTimeToUtc(2026, 7, 1, 9, 0, 'America/New_York');
    const winter = zonedTimeToUtc(2026, 12, 1, 9, 0, 'America/New_York');

    // Assert
    expect(new Date(summer).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(new Date(winter).toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
});

describe('latestDueSlot', () => {
  const schedule = { timezone: 'Asia/Tokyo', weekdays, times: ['11:00', '16:00'] };

  it('当日の過ぎた枠のうち最新を返す', () => {
    // Arrange: 2026-09-29(火) 17:00 JST
    const now = new Date('2026-09-29T08:00:00Z');

    // Act
    const slot = latestDueSlot(now, schedule);

    // Assert
    expect(slot?.toISOString()).toBe('2026-09-29T07:00:00.000Z');
  });

  it('当日の最初の枠より前なら前の営業日の最後の枠を返す', () => {
    // Arrange: 2026-09-28(月) 09:00 JST → 前の枠は 2026-09-25(金) 16:00 JST
    const now = new Date('2026-09-28T00:00:00Z');

    // Act
    const slot = latestDueSlot(now, schedule);

    // Assert
    expect(slot?.toISOString()).toBe('2026-09-25T07:00:00.000Z');
  });

  it('週末をまたいで停止していても最新の1枠だけを返す（AC-32）', () => {
    // Arrange: 2026-09-27(日) 20:00 JST
    const now = new Date('2026-09-27T11:00:00Z');

    // Act
    const slot = latestDueSlot(now, schedule);

    // Assert
    expect(slot?.toISOString()).toBe('2026-09-25T07:00:00.000Z');
  });

  it('枠ちょうどの時刻はその枠を返す', () => {
    // Arrange
    const now = new Date('2026-09-29T02:00:00Z');

    // Act / Assert
    expect(latestDueSlot(now, schedule)?.toISOString()).toBe('2026-09-29T02:00:00.000Z');
  });
});
