import { TextSchema, type ApprovedPlan, type Offer } from "@callmate/contracts";

export type Tone = "formal" | "very_polite" | "friendly" | NonNullable<ApprovedPlan["request"]["tone"]>;
export type SpokenPhrase = { id: string; es: string; en: string; kind: "filler" | "echo" | "waiting" | "reply" };
const phrase = (id: string, es: string, en: string, kind: SpokenPhrase["kind"] = "reply"): SpokenPhrase => ({ id, es, en, kind });
export const friendly = (tone: Tone) => {
  if (!Array.isArray(tone)) return tone === "friendly";
  const values = tone.map(value => value.toLowerCase());
  return values.includes("friendly") && !values.some(value => value === 'formal "usted"' || value === "very polite" || value === "formal" || value === "very_polite");
};
/** Slots are data, never markup, voice instructions, or arbitrary model-authored replies. */
export function speechSlot(value: string): string {
  const text = TextSchema.parse(value);
  if (/[\p{Cc}\p{Cf}<>]/u.test(text) || text.length > 200) throw new TypeError("Unsafe speech slot");
  return text;
}
export function processingPhrases(tone: Tone, group: "short" | "medium"): SpokenPhrase[] {
  const tu = friendly(tone);
  const entries = group === "short" ? [
    ["ok", "Vale, perfecto.", "OK, perfect."],
    ["understand", "Entiendo.", "I see."],
    ["second", "De acuerdo, un segundo.", "All right, one second."],
    ["see", tu ? "Mmm, vale… déjame ver." : "Mmm, vale… déjeme ver.", "Hmm, OK… let me see."],
    ["thanks", "Muy bien, gracias.", "Very good, thank you."],
  ] : [
    ["write", tu ? "Déjame que lo apunte un momento." : "Déjeme que lo apunte un momento.", "Let me just write that down."],
    ["noting", tu ? "Perdona, lo estoy anotando." : "Perdone, lo estoy anotando.", "Sorry, I’m noting it down."],
    ["check_all", "Vale, a ver si lo tengo todo…", "OK, let me check I have everything…"],
    ["check", "Un momentito, que lo compruebo.", "Just a moment, I’ll check."],
  ];
  return entries.map(([id, es, en]) => phrase(id!, es!, en!, "filler"));
}
export function waitingPhrase(tone: Tone, step: 0 | 1 | 2): SpokenPhrase {
  const tu = friendly(tone);
  return [
    phrase("wait_initial", "Un momento, por favor, tengo que confirmarlo con la persona a la que represento.",
      "One moment, please, I need to confirm this with the person I’m calling for.", "waiting"),
    phrase("wait_12", tu ? "Disculpa la espera, enseguida te digo." : "Disculpe la espera, enseguida le digo.",
      "Sorry for the wait, I’ll tell you in a moment.", "waiting"),
    phrase("wait_24", tu ? "Gracias por tu paciencia, ya casi lo tengo." : "Gracias por su paciencia, ya casi lo tengo.",
      "Thank you for your patience, almost there.", "waiting"),
  ][step]!;
}
export function repeatPhrase(tone: Tone, reason: "not_heard" | "not_understood" | "slower"): SpokenPhrase {
  const tu = friendly(tone);
  if (reason === "slower") return phrase("repeat_slower", tu
    ? "¿Podrías hablar un poco más despacio? Se te oye con algo de dificultad."
    : "¿Podría hablar un poco más despacio? Se le oye con algo de dificultad.",
  "Could you speak a little more slowly? It’s a bit hard to hear you.");
  if (reason === "not_understood") return phrase("repeat_understand", tu
    ? "Perdona, no te he entendido bien. ¿Puedes repetirlo?"
    : "Perdone, no le he entendido bien. ¿Puede repetirlo?", "Sorry, I didn’t quite understand. Could you repeat that?");
  // Do not leave “¿Se refiere a…?” unfinished or invent a detail when no echo is available.
  return phrase(`repeat_${reason}`, tu ? "Perdona, ¿me lo puedes repetir, por favor?"
    : "Perdone, ¿me lo puede repetir, por favor?", "Sorry, could you repeat that, please?");
}
export function echoPhrase(plan: ApprovedPlan, offer: Offer, field: "date" | "time" | "price" | "name" | "staff", clarify = false): SpokenPhrase | null {
  const tu = friendly(plan.request.tone ?? "formal");
  let es: string, en: string;
  switch (field) {
    case "date": es = offer.appointment.localDate; en = es; break;
    case "time": es = `${offer.appointment.localDate}, ${offer.appointment.localTime}`; en = es; break;
    case "price": {
      if (!offer.price) return null;
      const digits = String(offer.price.amountMinor).padStart(3, "0");
      const amount = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
      es = `${amount} euros`; en = `€${amount}`; break;
    }
    case "name": es = speechSlot(offer.bookingName); en = es; break;
    case "staff": if (!offer.staffName) return null; es = `con ${speechSlot(offer.staffName)}`; en = `with ${speechSlot(offer.staffName)}`; break;
  }
  if (clarify) return phrase(`clarify_${field}`, `${tu ? "Perdona, no te" : "Perdone, no le"} he entendido bien. ¿${tu ? "Te refieres" : "Se refiere"} a ${es}?`,
    `Sorry, I didn’t quite understand. Do you mean ${en}?`, "echo");
  return phrase(`echo_${field}`, `Entonces, si ${tu ? "te" : "le"} he entendido bien: ${es}. ¿Es correcto?`,
    `So, if I understood you correctly: ${en}. Is that correct?`, "echo");
}
export function cleanHairPhrase(): SpokenPhrase {
  return phrase("clean_dry_hair", "Entendido, con el pelo limpio y seco.", "Understood, with clean, dry hair.");
}
export function contactFallback(plan: ApprovedPlan): SpokenPhrase {
  const tu = friendly(plan.request.tone ?? "formal");
  return phrase("phone_timeout", `${tu ? "Perdona" : "Perdone"}, ahora mismo no puedo confirmar el teléfono. ¿${tu ? "Te" : "Le"} parece bien que la cita quede a nombre de ${speechSlot(plan.request.bookingName)} y ${tu ? "te llamemos más tarde para dártelo" : "le llamemos más tarde para dárselo"}?`,
    `Sorry, I can’t confirm the phone number right now. Is it OK if the appointment stays under ${plan.request.bookingName}'s name and we call you later with it?`);
}
export function callbackPhrase(tone: Tone): SpokenPhrase {
  const tu = friendly(tone);
  return phrase("callback_timeout", `${tu ? "Perdona" : "Perdone"}, no consigo confirmarlo ahora mismo. ¿${tu ? "Te" : "Le"} parece bien que ${tu ? "te" : "le"} vuelva a llamar en unos minutos?`,
    "Sorry, I can’t confirm it right now. Would it be OK if I call you back in a few minutes?");
}
export function plainReply(id: string, es: string, en: string): SpokenPhrase { return phrase(id, es, en); }
