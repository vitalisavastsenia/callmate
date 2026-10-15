import { describe, expect, it } from 'vitest';
import { parseGoalRules } from '../src/goalParser';
const now = new Date('2026-10-15T10:00:00Z');
const parse = (goal: string, timeZone = 'Europe/Madrid') => parseGoalRules(goal, { timeZone }, now);

describe('goal suggestions', () => {
  it('recognizes explicitly named destinations, international numbers, and requested manner', () => {
    const result = parse('Call "Clinic Sol" on +34 612 345 678 and ask about opening hours. Be very polite and speak slowly.');
    expect(result.businessName).toBe('Clinic Sol'); expect(result.businessPhone).toBe('+34612345678');
    expect(result.tone).toEqual(['Very polite', 'Speak slowly']);
    expect(parse('Ask my clinic about documents.').businessPhone).toBeUndefined();
  });
  it('extracts the demo vet goal without inventing an end time or booking authority', () => {
    const result = parse("Book a vet appointment for my dog on Thursday after 5 pm, ask the price of a rabies vaccine, don't agree to more than 60 euros.");
    expect(result.requestType).toBe('book'); expect(result.service).toBe('Vet appointment');
    expect(result.maximumPriceEur).toBe('60');
    expect(result.availability).toEqual({ date: '2026-10-22', start: '17:00' });
    expect(result.mustAskMe).toEqual(["don't agree to more than 60 euros."]);
    expect(result.canDecideAlone).toEqual([]); expect(result.notes.join(' ')).toContain('Complete the availability window');
  });
  it.each([
    ['Book a haircut next Tuesday between 5 and 7 pm, up to €30.', '17:00', '19:00', '30'],
    ['Book a haircut tomorrow from 17:30 to 19:00, under 30,50 euros.', '17:30', '19:00', '30.5'],
    ['Book a haircut tomorrow between 9 and 5 pm for 25 EUR.', '09:00', '17:00', '25'],
    ['Book a haircut on 2026-10-20 from 11 am until 1 pm, at most €40.', '11:00', '13:00', '40'],
  ])('parses bounded time and EUR phrases: %s', (goal, start, end, maximum) => {
    const result = parse(goal);
    expect(result.availability).toMatchObject({ start, end }); expect(result.maximumPriceEur).toBe(maximum);
  });
  it('resolves dates in the destination zone, including year rollover', () => {
    const late = new Date('2026-12-31T23:30:00Z');
    expect(parseGoalRules('Book a haircut tomorrow at 5 pm.', { timeZone: 'Europe/Madrid' }, late).availability?.date).toBe('2027-01-02');
    expect(parseGoalRules('Book a haircut tomorrow at 5 pm.', { timeZone: 'Atlantic/Canary' }, late).availability?.date).toBe('2027-01-01');
    expect(parse('Book a haircut October 20 at 5 pm.').availability?.date).toBe('2026-10-20');
  });
  it('keeps ambiguous, invalid, and multi-date windows incomplete for review', () => {
    expect(parse('Book a haircut next Tuesday between 5 and 7.').availability).toEqual({ date: '2026-10-20' });
    expect(parse('Book a haircut 2026-02-30 after 5 pm.').availability?.date).toBeUndefined();
    expect(parse('Book a haircut 2026-10-01 after 5 pm.').availability?.date).toBeUndefined();
    expect(parse('Book a haircut Monday or Tuesday between 17:00 and 19:00.').availability?.date).toBeUndefined();
    expect(parse('Book a haircut tomorrow from 19:00 to 17:00.').availability).toEqual({ date: '2026-10-16' });
  });
  it('does not treat dollars or a minimum spend as a maximum EUR price', () => {
    expect(parse('Book a haircut for $30 tomorrow.').maximumPriceEur).toBeUndefined();
    expect(parse('Book a haircut and spend more than 30 euros tomorrow.').maximumPriceEur).toBeUndefined();
  });
  it('retains explicit questions and negated booking boundaries', () => {
    const result = parse('Find out which documents I need. Which documents should I bring? Do I need a referral? Do not book an appointment.');
    expect(result.requestType).toBe('ask');
    expect(result.questions).toEqual(['Which documents should I bring?', 'Do I need a referral?']);
    expect(result.mustAskMe).toEqual(['Do not book an appointment.']);
    expect(result.availability).toBeUndefined();
  });
  it('extracts a new rescheduling window and reference without using the old date', () => {
    const result = parse('Reschedule my vet visit from Monday to Friday between 10 am and 12 pm. Booking reference VET-123. Ask me before confirming the change.');
    expect(result.requestType).toBe('change'); expect(result.bookingReference).toBe('VET-123');
    expect(result.availability).toEqual({ date: '2026-10-16', start: '10:00', end: '12:00' });
    expect(result.mustAskMe).toEqual(['Ask me before confirming the change.']);
  });
  it('does not turn an existing cancellation date into new availability', () => {
    const result = parse('Cancel my vet visit next Tuesday at 5 pm. Do not accept a cancellation fee.');
    expect(result.requestType).toBe('change'); expect(result.availability).toBeUndefined();
    expect(result.changeDescription).toContain('Cancel my vet visit');
  });
  it('extracts only explicit independent decisions', () => {
    const result = parse('Book a haircut next Tuesday. Zeus may choose any time in my window. Ask me before adding another service.');
    expect(result.canDecideAlone).toEqual(['Zeus may choose any time in my window.']);
    expect(result.mustAskMe).toEqual(['Ask me before adding another service.']);
  });
  it('supports generic custom goals and rejects empty inputs and invalid zones', () => {
    expect(parse('Leave a message for the manager.').requestType).toBe('other');
    expect(() => parse(' ')).toThrow('Enter a goal');
    expect(() => parse('Book a haircut.', 'invalid-zone')).toThrow('valid IANA timezone');
  });
});

it('never mistakes an ISO date or EUR range for availability times', () => {
  expect(parse('Book a haircut on 2026-10-20.').availability).toEqual({ date: '2026-10-20' });
  expect(parse('Book a haircut on 2026-10-20 after 5 pm.').availability).toEqual({ date: '2026-10-20', start: '17:00' });
  expect(parse('Book a haircut tomorrow for 10-20 euros.').availability).toEqual({ date: '2026-10-16' });
  expect(parse('Book a haircut under €1,200 tomorrow.').maximumPriceEur).toBeUndefined();
});
