import { ZonedTimeSchema, type ZonedTime } from './types';

export function localDateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (key: string) => parts.find(p => p.type === key)?.value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

export function nextTuesday(timeZone: string, now = new Date()): string {
  const today = new Date(localDateInZone(now, timeZone) + 'T12:00:00Z');
  today.setUTCDate(today.getUTCDate() + ((2 - today.getUTCDay() + 7) % 7 || 7));
  return today.toISOString().slice(0, 10);
}

export function resolveTime(localDate: string, localTime: string, timeZone: string, occurrence = ''): ZonedTime {
  const naive = Date.parse(localDate + 'T' + localTime + ':00Z');
  if (!Number.isFinite(naive)) throw new Error('Enter a valid calendar date and time.');
  // The UI offers Spain's two zones. Enumerate offsets to detect DST gaps/overlaps.
  const candidates: ZonedTime[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const instant = new Date(naive + offset * 60_000).toISOString();
    const parsed = ZonedTimeSchema.safeParse({ localDate, localTime, timeZone, instant });
    if (parsed.success) candidates.push(parsed.data);
  }
  if (!candidates.length) throw new Error('This local time does not exist because the clocks change. Choose another time.');
  if (candidates.length > 1 && !occurrence) throw new Error('This local time occurs twice because the clocks change. Choose the earlier or later occurrence.');
  return candidates[occurrence === 'later' ? candidates.length - 1 : 0]!;
}

export function zonedFromInstant(instant: string, timeZone: string): ZonedTime {
  const date = new Date(instant);
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return ZonedTimeSchema.parse({ localDate: localDateInZone(date, timeZone), localTime, timeZone, instant: date.toISOString() });
}

export function describeTime(time: ZonedTime): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: time.timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(time.instant)) + ' · ' + time.timeZone;
}

export function money(value: { amountMinor: number; currency: string } | null): string {
  return value ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: value.currency }).format(value.amountMinor / 100) : 'Unavailable';
}
