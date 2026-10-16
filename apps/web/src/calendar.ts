import { CallSnapshotSchema, type CallSnapshot } from './types';

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
const stamp = (instant: string) => new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function fold(line: string): string {
  const rows: string[] = [];
  let row = '';
  let size = 0;
  for (const char of line) {
    const bytes = new TextEncoder().encode(char).length;
    if (size + bytes > 75) { rows.push(row); row = ' '; size = 1; }
    row += char; size += bytes;
  }
  rows.push(row);
  return rows.join('\r\n');
}

export function calendarText(value: CallSnapshot): string {
  const call = CallSnapshotSchema.parse(value);
  if (call.outcome.status !== 'confirmed') throw new Error('Only confirmed bookings can be exported.');
  const offer = call.outcome.offer;
  const time = offer.appointment;
  const simulation = call.mode === 'simulator';
  const details = (simulation ? 'Simulation only. No real business appointment was confirmed. ' : '') + 'Booked under ' + offer.bookingName + '. Business local time: ' + time.localDate + ' ' + time.localTime + ' (' + time.timeZone + '). ' + (offer.durationMinutes === null ? 'Duration unknown; confirm with the business.' : 'Duration: ' + offer.durationMinutes + ' minutes.');
  const rows = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Zeus Llama//Confirmed appointments//EN', 'CALSCALE:GREGORIAN',
    'X-WR-TIMEZONE:' + time.timeZone, 'BEGIN:VEVENT', 'UID:' + call.id + '@zeus-llama.local',
    'DTSTAMP:' + stamp(call.outcome.confirmedAt), 'DTSTART:' + stamp(time.instant),
    'SUMMARY:' + escapeText((simulation ? '[Simulation] ' : '') + offer.service + ' · ' + call.plan.request.business.name),
    'LOCATION:' + escapeText(call.plan.request.business.name), 'DESCRIPTION:' + escapeText(details), simulation ? 'STATUS:TENTATIVE' : 'STATUS:CONFIRMED',
  ];
  if (offer.durationMinutes !== null) rows.push('DTEND:' + stamp(new Date(Date.parse(time.instant) + offer.durationMinutes * 60_000).toISOString()));
  rows.push('END:VEVENT', 'END:VCALENDAR');
  return rows.map(fold).join('\r\n') + '\r\n';
}

export function downloadCalendar(call: CallSnapshot): void {
  const url = URL.createObjectURL(new Blob([calendarText(call)], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'zeus-llama-' + call.id + '.ics';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
