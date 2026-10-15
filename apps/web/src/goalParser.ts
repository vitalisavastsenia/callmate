import { TimeZoneSchema, type GoalParseContext, type ParsedGoal } from './types';
import { localDateInZone } from './time';

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const clock = '(\\d{1,2}(?::\\d{2})?)\\s*(a\\.?m\\.?|p\\.?m\\.?)?';
function toTime(value: string, marker?: string): string | undefined {
  let [hour, minute = 0] = value.split(':').map(Number);
  if (hour === undefined || hour > 23 || minute > 59) return;
  if (marker) {
    if (hour < 1 || hour > 12) return;
    hour = hour % 12 + (marker.toLowerCase().startsWith('p') ? 12 : 0);
  }
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}
function parseTimes(input: string, notes: string[]) {
  // A calendar date or a price range is not a clock range.
  const text = input.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').replace(/€\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:euros?|EUR)\b/gi, '');
  const range = text.match(new RegExp('\\b(?:between|from)\\s+' + clock + '\\s*(?:and|to|until|[–-])\\s*' + clock, 'i'))
    ?? text.match(new RegExp('\\b' + clock + '\\s*(?:to|until|[–-])\\s*' + clock, 'i'));
  if (range) {
    const [, first = '', firstMarker, last = '', lastMarker] = range;
    if (!firstMarker && !lastMarker && !first.includes(':') && Number(first) <= 12 && Number(last) <= 12) {
      notes.push('The time range needs AM/PM or 24-hour times. Enter it manually.'); return {};
    }
    const end = toTime(last, lastMarker);
    let start = toTime(first, firstMarker ?? lastMarker);
    // “Between 9 and 5 pm” crosses noon, unlike “between 5 and 7 pm”.
    if (!firstMarker && lastMarker?.toLowerCase().startsWith('p') && start && end && start >= end) start = toTime(first, 'am');
    if (!start || !end || start >= end) { notes.push('The time range is invalid or crosses midnight. Enter separate valid windows manually.'); return {}; }
    return { start, end };
  }
  const single = text.match(new RegExp('\\b(after|before|at)\\s+' + clock, 'i'));
  if (single) {
    if (!single[3] && !single[2]!.includes(':') && Number(single[2]) <= 12) { notes.push('The time needs AM/PM or a 24-hour time.'); return {}; }
    const value = toTime(single[2]!, single[3]);
    if (!value) { notes.push('The time is invalid. Enter it manually.'); return {}; }
    notes.push('Only one time boundary was stated. Complete the availability window before reviewing.');
    return single[1]!.toLowerCase() === 'before' ? { end: value } : { start: value };
  }
  return {};
}
function parseDate(text: string, timeZone: string, now: Date, notes: string[]): string | undefined {
  const today = localDateInZone(now, timeZone);
  const day = new Date(today + 'T12:00:00Z');
  const iso = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
  const named = [...text.matchAll(/\b(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/gi)];
  if (iso.length + named.length > 1) { notes.push('More than one date was mentioned. Set the intended availability windows manually.'); return; }
  let result: string | undefined;
  if (iso[0]) {
    result = iso[0][0];
    const parsed = new Date(result + 'T12:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) { notes.push('The calendar date is invalid.'); return; }
  } else if (named[0]) {
    const name = named[0][0].toLowerCase().replace(/^next\s+/, '');
    const days = name === 'today' ? 0 : name === 'tomorrow' ? 1 : (weekdays.indexOf(name) - day.getUTCDay() + 7) % 7 || 7;
    day.setUTCDate(day.getUTCDate() + days); result = day.toISOString().slice(0, 10);
    notes.push('Interpreted “' + named[0][0] + '” as ' + result + ' in ' + timeZone + '. Check this date.');
  } else {
    const monthPattern = months.join('|');
    const monthDate = text.match(new RegExp('\\b(' + monthPattern + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b', 'i'));
    if (monthDate) {
      result = (monthDate[3] ?? today.slice(0, 4)) + '-' + String(months.indexOf(monthDate[1]!.toLowerCase()) + 1).padStart(2, '0') + '-' + monthDate[2]!.padStart(2, '0');
      const parsed = new Date(result + 'T12:00:00Z');
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) { notes.push('The calendar date is invalid.'); return; }
      if (!monthDate[3]) notes.push('Used the current year for ' + result + '. Check the year.');
    }
  }
  if (result && result < today) { notes.push('The stated date is in the past. Choose a future date.'); return; }
  return result;
}

// Deterministic suggestions only: no dialing, planning authority, or network access.
export function parseGoalRules(goal: string, context: GoalParseContext, now = new Date()): ParsedGoal {
  const text = goal.trim().replace(/[‘’]/g, "'");
  if (!text || text.length > 4000) throw new Error('Enter a goal in English (up to 4,000 characters).');
  if (!TimeZoneSchema.safeParse(context.timeZone).success) throw new Error('Choose a valid IANA timezone before filling details.');
  const notes: string[] = [];
  const clauses = text.split(/(?<=[.!?])\s+|[;\n]+|,\s*(?=(?:do not|don't|never|ask me|only|zeus may|you may|no\s))/i).map(s => s.trim()).filter(Boolean);
  // Ignore negated verbs when choosing a type; “ask …, don't book” is an enquiry.
  const intent = clauses.filter(s => !/^(?:ask me|check with me|zeus may|you may|never|no\s|do not|don't)\b/i.test(s)).join(' ');
  const positive = intent.replace(/\b(?:do not|don't|never)\s+(?:book|reserve|cancel|reschedule|change)\b/gi, '');
  const requestType = /\b(?:reschedule|cancel|move|change)\b/i.test(positive) ? 'change'
    : /\b(?:book|reserve|schedule|arrange)\b/i.test(positive) ? 'book'
    : /\b(?:ask|find out|inquire|enquire|check|which|what|whether|how|do i need)\b/i.test(positive) ? 'ask'
    : context.requestType ?? 'other';
  const result: ParsedGoal = { requestType, canDecideAlone: [], mustAskMe: [], notes };
  const phone = [...text.matchAll(/\+\d[\d ().-]{6,}\d/g)];
  if (phone.length === 1) {
    const normalized = phone[0]![0].replace(/[\s().-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(normalized)) result.businessPhone = normalized;
  }
  const name = text.match(/\b(?:call|contact)\s+["“]([^"”]{1,200})["”]/i)?.[1]
    ?? text.match(/\b(?:call|contact)\s+([^.,!?\n+]{1,200}?)\s+(?:at|on)\s+\+/i)?.[1];
  if (name) result.businessName = name.trim();
  result.tone = [[/\bvery polite|extra polite\b/i, 'Very polite'], [/\busted|formal\b/i, 'Formal "usted"'], [/\bfriendly\b/i, 'Friendly'], [/\bfirm\b/i, 'Firm'], [/\bspeak slowly\b/i, 'Speak slowly']]
    .filter(([pattern]) => (pattern as RegExp).test(text)).map(([, label]) => label as string);
  for (const clause of clauses) {
    if (/\b(?:do not|don't|never|must not|no deposits?|no fees?|ask me|check with me|only after|only if i approve)\b/i.test(clause)) result.mustAskMe.push(clause);
    else if (/\b(?:zeus|you)\s+(?:may|can)|\bdecide (?:alone|without asking)|\bautomatically within\b/i.test(clause)) result.canDecideAlone.push(clause);
  }
  if (requestType === 'book') {
    const services: [RegExp, string][] = [[/\bhaircut|\bhair cut\b/i, 'Haircut'], [/\b(?:vet|veterinary)\s+(?:appointment|visit)\b/i, 'Vet appointment'], [/\b(?:dentist|dental)\b/i, 'Dental appointment'], [/\brabies\s+(?:vaccine|vaccination)\b/i, 'Rabies vaccination'], [/\b(?:doctor|medical)\s+(?:appointment|visit)\b/i, 'Medical appointment']];
    const knownService = services.find(([pattern]) => pattern.test(text))?.[1];
    if (knownService) result.service = knownService;
    if (!result.service) {
      const service = text.match(/\b(?:book|reserve|schedule|arrange)\s+(?:me\s+)?(?:an?\s+)?(.+?)(?=\s+(?:on|for|next|today|tomorrow|at|between|after|before|under|with|up to)\b|[.,;!?]|$)/i)?.[1]?.trim();
      if (service && service.length <= 200) result.service = service[0]!.toUpperCase() + service.slice(1);
    }
    const cap = text.match(/\b(?:no more than|not more than|(?:don't|do not)\s+(?:spend|pay|agree to)\s+more than|at most|up to|under|less than|max(?:imum)?(?:\s+(?:price|budget))?(?:\s*(?:of|is|:))?|budget(?:\s*(?:of|is|:))?|for)\s*(?:€\s*(\d+(?:[.,]\d{1,2})?)(?!\d|[.,]\d)|(\d+(?:[.,]\d{1,2})?)\s*(?:euros?|EUR)\b)/i);
    if (cap) {
      const amount = Number((cap[1] ?? cap[2])!.replace(',', '.'));
      if (Number.isSafeInteger(Math.round(amount * 100))) result.maximumPriceEur = String(amount);
    }
  }
  if (requestType === 'ask') {
    const questions = clauses.filter(s => s.endsWith('?'));
    result.questions = questions.length ? questions : /\bdocuments?|paperwork\b/i.test(text) ? ['Which documents are required?']
      : /\bopening hours|\bopen(?:s|ing)?\b/i.test(text) ? ['What are your opening hours?']
      : /\bprice|\bcost\b/i.test(text) ? ['What is the price of the requested service?']
      : [text.replace(/^(?:please\s+)?(?:ask|find out|check)\s+/i, 'Please clarify: ')];
  }
  if (requestType === 'change') {
    result.changeDescription = clauses.find(s => /\b(?:reschedule|cancel|move|change)\b/i.test(s)) ?? text;
    const reference = text.match(/\b(?:booking\s+(?:reference|ref)|reference|confirmation (?:number|code))\s*(?:is\s*|[:#]\s*)?([A-Z0-9][A-Z0-9-]{2,})\b/i);
    if (reference?.[1]) result.bookingReference = reference[1];
  }
  if (requestType === 'book' || requestType === 'change') {
    // Cancellation dates describe the existing booking, not new availability.
    const cancellation = requestType === 'change' && /\bcancel\b/i.test(positive) && !/\breschedule|\bmove|\bchange\b/i.test(positive);
    const changeClause = clauses.find(s => /\b(?:reschedule|move|change)\b/i.test(s)) ?? text;
    const target = requestType === 'change' ? changeClause.replace(/^.*?\b(?:reschedule|move|change)\b.*?\bto\s+/i, '') : text;
    if (!cancellation) {
      const date = parseDate(target, context.timeZone, now, notes);
      const times = parseTimes(target, notes);
      if (date || Object.keys(times).length) result.availability = { ...(date ? { date } : {}), ...times };
      if (!date) notes.push('No supported future date was found. Add the intended date manually.');
    }
  }
  if (result.canDecideAlone.length > 30 || result.mustAskMe.length > 30 || (result.questions?.length ?? 0) > 30) throw new Error('There are too many list items. Use at most 30 questions or boundaries.');
  notes.push('These are editable suggestions. Review dates, times, prices, and permissions before starting a call.');
  return result;
}
