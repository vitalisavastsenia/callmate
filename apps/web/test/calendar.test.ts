import { describe, expect, it } from 'vitest';
import { confirmedCallFixture, uncertainCallFixture } from '@callmate/contracts/fixtures';
import { calendarText } from '../src/calendar';
import { resolveTime, nextTuesday } from '../src/time';

describe('confirmed-only calendar export', () => {
  it('preserves the appointment instant and business timezone without inventing a duration', () => {
    const text = calendarText(confirmedCallFixture);
    expect(text).toContain('DTSTART:20261020T160000Z');
    expect(text).toContain('X-WR-TIMEZONE:Europe/Madrid');
    expect(text.replace(/\r\n /g, '')).toContain('2026-10-20 18:00 (Europe/Madrid)');
    expect(text).not.toContain('DTEND'); expect(text).not.toContain('DURATION:');
    expect(() => calendarText(uncertainCallFixture)).toThrow('Only confirmed');
  });
  it('escapes calendar fields and folds UTF-8 lines at 75 octets', () => {
    const value = structuredClone(confirmedCallFixture);
    if (value.outcome.status !== 'confirmed') throw new Error();
    value.outcome.offer.service = 'é'.repeat(80) + '\nBEGIN:VEVENT';
    const text = calendarText(value);
    expect(text).not.toContain('\r\nBEGIN:VEVENT\r\nBEGIN:VEVENT');
    expect(text.replace(/\r\n /g, '')).toContain('\\nBEGIN:VEVENT');
    expect(text.trimEnd().split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
  });
});
describe('business timezone dates', () => {
  it('resolves relative weekdays using the business date', () => {
    expect(nextTuesday('Europe/Madrid', new Date('2026-10-15T10:00:00Z'))).toBe('2026-10-20');
  });
  it('rejects nonexistent times and requires a choice for repeated times', () => {
    expect(() => resolveTime('2026-03-29', '02:30', 'Europe/Madrid')).toThrow('does not exist');
    expect(() => resolveTime('2026-10-25', '02:30', 'Europe/Madrid')).toThrow('occurs twice');
    const earlier = resolveTime('2026-10-25', '02:30', 'Europe/Madrid', 'earlier');
    const later = resolveTime('2026-10-25', '02:30', 'Europe/Madrid', 'later');
    expect(Date.parse(later.instant) - Date.parse(earlier.instant)).toBe(3600000);
    expect(resolveTime('2026-10-20', '17:00', 'Atlantic/Canary').instant).toBe('2026-10-20T16:00:00.000Z');
  });
});

// The mode is the authority for simulation labelling, not text in the outcome.
it.each(['simulator', 'live'] as const)('exports %s with an honest event title and status', mode => {
  const call = structuredClone(confirmedCallFixture); call.mode = mode;
  const text = calendarText(call).replace(/\r\n /g, '');
  if (mode === 'simulator') {
    expect(text).toContain('SUMMARY:[Simulation] ');
    expect(text).toContain('DESCRIPTION:Simulation only. No real business appointment was confirmed. ');
    expect(text).toContain('STATUS:TENTATIVE');
    expect(text).not.toContain('STATUS:CONFIRMED');
  } else {
    expect(text).not.toContain('[Simulation]'); expect(text).not.toContain('Simulation only');
    if (call.outcome.status !== 'confirmed') throw new Error();
    expect(text).toContain('SUMMARY:' + call.outcome.offer.service + ' · ' + call.plan.request.business.name);
    expect(text).toContain('STATUS:CONFIRMED');
  }
  expect(text).toContain('DTSTART:20261020T160000Z'); expect(text).not.toContain('DTEND');
});
