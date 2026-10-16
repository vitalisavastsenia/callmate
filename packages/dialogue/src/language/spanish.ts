import { templateForService } from "@callmate/contracts";
import type { ApprovedPlan, CandidateAction, Offer } from "@callmate/contracts";
import { friendly, speechSlot, type Tone } from "./conversation.js";

const normalize = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es-ES");

/** Controlled MVP vocabulary; unknown services require clarification rather than guessed translation. */
export function serviceKey(service: string): string | null {
  return templateForService(service)?.id ?? null;
}
export function namesMatch(left: string, right: string): boolean { return normalize(left) === normalize(right); }

const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const dateSpanish = (date: string) => {
  const [year, month, day] = date.split("-");
  return `${Number(day)} de ${months[Number(month) - 1]} de ${year}`;
};
export function zoneSpanish(appointment: Offer["appointment"]): string {
  const friendly: Record<string, string> = {
    "Europe/Madrid": "Madrid", "Atlantic/Canary": "Canarias", "Africa/Ceuta": "Ceuta",
  };
  const offset = (Date.parse(`${appointment.localDate}T${appointment.localTime}:00Z`) - Date.parse(appointment.instant)) / 60000;
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `hora de ${friendly[appointment.timeZone] ?? appointment.timeZone} (UTC${offset < 0 ? "-" : "+"}${hours}:${minutes})`;
}
function priceSpanish(offer: Offer): string {
  if (offer.price === null) return "con el precio todavía sin determinar";
  const digits = String(offer.price.amountMinor).padStart(3, "0");
  const euros = digits.slice(0, -2);
  const cents = Number(digits.slice(-2));
  return `por ${euros} ${euros === "1" ? "euro" : "euros"}${cents ? ` con ${cents} ${cents === 1 ? "céntimo" : "céntimos"}` : ""}`;
}
export function offerDetails(plan: ApprovedPlan, offer: Offer): string {
  // Service and name come from the reviewed plan, never arbitrary business/model text.
  const duration = offer.durationMinutes === null ? "" : `, con una duración de ${offer.durationMinutes} ${offer.durationMinutes === 1 ? "minuto" : "minutos"}`;
  const staff = offer.staffName ? `, con ${speechSlot(offer.staffName)}` : "";
  return `un corte de pelo el ${dateSpanish(offer.appointment.localDate)} a las ${offer.appointment.localTime}, ${zoneSpanish(offer.appointment)}, a nombre de ${plan.request.bookingName}${staff}${duration}, ${priceSpanish(offer)}, sin depósito, sin gastos de cancelación y sin extras de pago obligatorios`;
}

export function renderReadback(plan: ApprovedPlan, offer: Offer): string {
  return `Para comprobar los datos, la propuesta es ${offerDetails(plan, offer)}. Todavía no estoy aceptando la reserva. ¿Son correctos estos datos?`;
}
export function renderAcceptance(plan: ApprovedPlan, offer: Offer): string {
  return `Acepto la cita para ${offerDetails(plan, offer)}. ¿${friendly(plan.request.tone ?? "formal") ? "Puedes" : "Puede"} confirmar que queda reservada con esos datos?`;
}
export function renderAvailability(plan: ApprovedPlan): string {
  const windows = plan.request.availability.map(({ start, end }) => {
    return `desde el ${dateSpanish(start.localDate)} a las ${start.localTime}, ${zoneSpanish(start)}, hasta el ${dateSpanish(end.localDate)} a las ${end.localTime}, ${zoneSpanish(end)}`;
  }).join("; o bien ");
  return `¿${friendly(plan.request.tone ?? "formal") ? "Tienes" : "Tiene"} disponibilidad para un corte de pelo ${windows}?`;
}

type ClarificationField = Extract<CandidateAction, { action: "clarify" }>["missing"][number];
const questions: Record<ClarificationField, string> = {
  service: "¿Puede confirmar qué servicio se ofrece?",
  details: "¿Puede confirmar los detalles del servicio solicitado?",
  name: "¿Puede confirmar el nombre de la persona para la cita?",
  date: "¿Puede indicar el día, el mes y el año de la cita?",
  time: "¿Puede confirmar la hora exacta y la zona horaria de la cita?",
  price: "¿Puede confirmar el precio total del corte de pelo?",
  conditions: "¿Puede confirmar que no se exige depósito, pago anticipado, gastos de cancelación ni extras de pago?",
};
export function renderClarification(fields: ClarificationField[], tone: Tone = "formal"): string {
  const text = [...new Set(fields)].map((field) => questions[field]).join(" ");
  return friendly(tone) ? text.replaceAll("¿Puede", "¿Puedes") : text;
}
export function renderClosing(reason: Extract<CandidateAction, { action: "end_call" }>["reason"]): string {
  if (reason === "unresolved") return "Lo siento, no he podido aclarar los detalles y no puedo aceptar la propuesta. Gracias por su tiempo. Hasta luego.";
  return "Entendido. Muchas gracias por su tiempo. Hasta luego.";
}

/** Non-committing controller replies; the controller must still issue playback permits. */
export const spanishWaitingForApproval = (): string => "Necesito consultar esta propuesta con la persona interesada antes de aceptar nada. ¿Puede esperar un momento, por favor?";
export const spanishDeclineOffer = (): string => "Lo siento, no puedo aceptar esta propuesta con las instrucciones autorizadas. Gracias por su tiempo. Hasta luego.";
