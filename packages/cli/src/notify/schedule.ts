const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(ts: number, tz: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

function offsetMs(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000
  );
}

/** タイムゾーンの壁時計時刻をUTCの時刻へ変換する */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

export interface NotificationSchedule {
  timezone: string;
  weekdays: readonly string[];
  times: readonly string[];
}

/**
 * 現在時刻以前で最も新しい通知枠を返す（13.4 missed_slot_policy: latest_only）。
 * 過去8日以内に枠がなければ null。
 */
export function latestDueSlot(now: Date, schedule: NotificationSchedule): Date | null {
  const nowMs = now.getTime();
  const today = zonedParts(nowMs, schedule.timezone);
  const times = [...schedule.times]
    .map((t) => t.split(':').map(Number) as [number, number])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (let back = 0; back <= 8; back++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
    const weekday = WEEKDAYS[date.getUTCDay()];
    if (!weekday || !schedule.weekdays.includes(weekday)) continue;
    for (const [h, m] of times) {
      const slot = zonedTimeToUtc(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        h,
        m,
        schedule.timezone,
      );
      if (slot <= nowMs) return new Date(slot);
    }
  }
  return null;
}
