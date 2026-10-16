import type { ConfirmationVerifier } from "@callmate/dialogue";

const normalizedText = (message: { originalText: string; language: string }) =>
  message.originalText.normalize("NFC").toLocaleLowerCase(message.language)
    .replace(/[.,!?¿¡;:«»„“”"']/gu, " ").replace(/\s+/gu, " ").trim();

// Deliberately bounded for development. Context/evidence ordering is checked separately
// by the booking library. Free-form confirmations must be clarified, never guessed.
export const verifyMockConfirmation: ConfirmationVerifier = ({ evidence }) => {
  if (evidence.length !== 1) return "ambiguous";
  const message = evidence[0]!;
  if (/[¿?]/u.test(message.originalText)) return "ambiguous";
  const text = normalizedText(message);
  const confirmations: Record<string, RegExp> = {
    "ru-RU": /^(?:да(?: всё (?:так|верно|правильно))?|всё (?:так|верно|правильно)|(?:да )?(?:я )?(?:подтверждаю|(?:уже )?подтвердил[аи]?)(?: (?:это|запись))?|(?:да )?(?:записал[аи]?|записано|запись подтверждена)(?: вас)?)(?: (?:большое )?спасибо)?$/u,
    "es-ES": /^(?:sí(?: (?:todo (?:correcto|está correcto)|está (?:confirmada|reservada)))?|(?:sí )?(?:yo )?(?:confirmo(?: (?:la (?:cita|reserva)|eso))?|(?:ya )?(?:lo |la )?(?:he confirmado|confirmé)(?: (?:la (?:cita|reserva)|eso))?)|(?:la )?(?:cita|reserva) (?:está )?(?:confirmada|reservada)|confirmado|todo correcto)(?: (?:muchas )?gracias)?$/u,
    "en-US": /^(?:yes(?: (?:that is|that s|all|everything is) correct)?|(?:yes )?i (?:confirm|(?:(?:have|ve) )?(?:already )?confirmed)(?: (?:that|it|the (?:appointment|booking|reservation)))?|(?:the )?(?:appointment|booking|reservation) is (?:confirmed|booked)|(?:yes )?(?:confirmed|booked)|that is correct)(?: (?:thank you|thanks))?$/u,
    "pl-PL": /^(?:tak(?: wszystko się zgadza)?|wszystko się zgadza|(?:tak )?(?:ja )?(?:potwierdzam(?: (?:to|rezerwację|wizytę))?|(?:już )?(?:potwierdził(?:em|am)(?: (?:to|rezerwację|wizytę))?|to potwierdził(?:em|am)))|(?:rezerwacja|wizyta) (?:jest )?potwierdzona|zapisane)(?: dziękuję)?$/u,
  };
  return confirmations[message.language]?.test(text) ? "affirmed" : "ambiguous";
};

// Agreement with the readback can include an invitation to book. That invitation
// is not evidence that the business has already made the booking.
export const verifyMockReadback: ConfirmationVerifier = context => {
  if (verifyMockConfirmation(context) === "affirmed") return "affirmed";
  if (context.evidence.length !== 1) return "ambiguous";
  const message = context.evidence[0]!;
  const invitations: Record<string, RegExp> = {
    "ru-RU": /^(?:да )?всё (?:так|верно|правильно) (?:вас записать|записать вас)(?: (?:в|на) это время)?$/u,
    "es-ES": /^(?:sí )?todo (?:correcto|está correcto) (?:le reservo|le reservo la cita)(?: (?:a|para) esa hora)?$/u,
    "en-US": /^(?:yes )?(?:that(?: is| s)(?: all)?|all|everything is) correct shall i book you (?:for|at) that time$/u,
    "pl-PL": /^(?:tak )?wszystko się zgadza czy (?:zapisać|mam zapisać) (?:pana|panią) na tę godzinę$/u,
  };
  return invitations[message.language]?.test(normalizedText(message)) ? "affirmed" : "ambiguous";
};
