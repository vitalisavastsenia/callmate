import { conversationTemplates, templateForRequest, TextSchema, type ApprovedPlan, type CandidateAction, type Offer } from "@callmate/contracts";
import { friendly, repeatPhrase, speechSlot } from "./conversation.js";
import * as spanish from "./spanish.js";

export type DialogueLanguage = "es-ES" | "ru-RU" | "en-US" | "pl-PL";
export type PhraseEntry = { id: string; version: number; language: DialogueLanguage; template: string };
export type PhraseLookup = (id: string, version: number, language: DialogueLanguage) => string;
export type RenderedReply = { phrase: { id: string; version: number; language: DialogueLanguage }; text: string; translationEn: string };
type Plan = Pick<ApprovedPlan, "request">;
const languages: DialogueLanguage[] = ["es-ES", "ru-RU", "en-US", "pl-PL"];
// Slot substitution is literal, single-pass data interpolation. Never evaluated as code or markup.
const templates: Record<string, [string, string, string, string]> = {
  clarification: ["{questions}", "{questions}", "{questions}", "{questions}"],
  on_behalf: ["en nombre de {name}", "от имени {name}", "on behalf of {name}", "w imieniu {name}"],
  greeting: [
    "Hola, soy un asistente de inteligencia artificial. Llamo para consultar una cita para un corte de pelo. ¿Puede ayudarme?",
    "Здравствуйте, я помощник на основе искусственного интеллекта. Я звоню, чтобы узнать о записи на стрижку. Можете мне помочь?",
    "Hello, I am an AI assistant. I am calling to ask about a haircut appointment. Could you help me?",
    "Dzień dobry, jestem asystentem opartym na sztucznej inteligencji. Dzwonię w sprawie terminu strzyżenia. Czy mogę prosić o pomoc?"],
  availability: [
    "Hola, soy Zeus, un asistente de inteligencia artificial y llamo en nombre de {name} para consultar una cita para un corte de pelo. ¿{can} disponibilidad {windows}?",
    "Здравствуйте, я Зевс, помощник на основе искусственного интеллекта. Я звоню от имени {name}, чтобы узнать о записи на стрижку. Есть ли свободное время в следующие интервалы: {windows}?",
    "Hello, I am Zeus, an AI assistant calling on behalf of {name} to ask about a haircut appointment. Is there availability within these windows: {windows}?",
    "Dzień dobry, jestem Zeus, asystent oparty na sztucznej inteligencji. Dzwonię w imieniu {name} w sprawie terminu strzyżenia. Czy są wolne terminy w następujących przedziałach: {windows}?"],
  details: ["{details}",
    "стрижка {date} в {time}, {zone}, имя для записи: {name}{staff}{duration}, {price}, без задатка, без платы за отмену и без обязательных платных дополнительных услуг",
    "a haircut on {date} at {time}, {zone}, under the name {name}{staff}{duration}, {price}, with no deposit, no cancellation fee and no mandatory paid extras",
    "strzyżenie dnia {date} o {time}, {zone}, na nazwisko {name}{staff}{duration}, {price}, bez zaliczki, opłaty za odwołanie i obowiązkowych płatnych dodatków"],
  staff: [", con {name}", ", сотрудник: {name}", ", with {name}", ", pracownik: {name}"],
  duration: [", con una duración de {minutes} minutos", ", продолжительность: {minutes} мин.", ", duration: {minutes} minutes", ", czas trwania: {minutes} min"],
  price: ["por {amount} euros", "цена: {amount} EUR", "price: {amount} EUR", "cena: {amount} EUR"],
  price_unknown: ["con el precio todavía sin determinar", "цена пока неизвестна", "price still unknown", "cena jeszcze nieznana"],
  window: ["desde el {start} a las {startTime}, {startZone}, hasta el {end} a las {endTime}, {endZone}",
    "с {start} {startTime}, {startZone}, до {end} {endTime}, {endZone}",
    "from {start} at {startTime}, {startZone}, to {end} at {endTime}, {endZone}",
    "od {start} o {startTime}, {startZone}, do {end} o {endTime}, {endZone}"],
  readback: ["Para comprobar los datos, la propuesta es {details}. Todavía no estoy aceptando la reserva. ¿Son correctos estos datos?",
    "Проверим детали предложения: {details}. Я пока не принимаю предложение о записи. Всё верно?",
    "To check the details, the proposal is {details}. I am not accepting the booking yet. Are these details correct?",
    "Sprawdźmy szczegóły propozycji: {details}. Jeszcze nie akceptuję rezerwacji. Czy te dane są poprawne?"],
  acceptance: ["Acepto la cita para {details}. ¿{can} confirmar que queda reservada con esos datos?",
    "Я принимаю запись на следующих условиях: {details}. Подтвердите, пожалуйста, что запись оформлена именно с этими данными.",
    "I accept the appointment for {details}. Can you confirm it is booked with those details?",
    "Akceptuję termin na następujących warunkach: {details}. Czy można potwierdzić rezerwację z tymi danymi?"],
  waiting: [spanish.spanishWaitingForApproval(),
    "Прежде чем что-либо принимать, мне нужно согласовать это предложение с человеком, от имени которого я звоню. Подождите, пожалуйста.",
    "I need to check this proposal with the person I am calling for before accepting anything. Could you wait a moment, please?",
    "Zanim cokolwiek zaakceptuję, muszę uzgodnić tę propozycję z osobą, w imieniu której dzwonię. Proszę chwilę poczekać."],
  confirm_details: [
    "¿Son correctos todos los datos de la propuesta que acabo de leer? Todavía no he aceptado la reserva.",
    "Все ли детали предложения я перечислил правильно? Я пока не принимаю запись.",
    "Are all the proposal details I just read correct? I have not accepted the booking yet.",
    "Czy wszystkie odczytane szczegóły propozycji są poprawne? Jeszcze nie akceptuję rezerwacji."],
  confirm_booking: [
    "¿Puede confirmar claramente que la reserva ya está hecha con los datos que acabo de aceptar?",
    "Подтвердите, пожалуйста: запись уже оформлена на тех условиях, которые я только что принял?",
    "Could you confirm clearly that the booking has been made with the details I just accepted?",
    "Czy można jednoznacznie potwierdzić, że rezerwacja została dokonana na zaakceptowanych przeze mnie warunkach?"],
  booking_unavailable: [
    "Gracias por la información. Esta llamada de prueba no puede completar reservas. Por favor, no formalice ninguna reserva; habrá que confirmarla por separado.",
    "Спасибо за уточнение. В этом тестовом звонке я не могу оформить запись. Пожалуйста, пока не бронируйте время; запись нужно подтвердить отдельно.",
    "Thank you for the information. This test call cannot complete a booking. Please do not make a reservation; it will need to be confirmed separately.",
    "Dziękuję za informację. Podczas tej rozmowy testowej nie mogę dokonać rezerwacji. Proszę na razie nie rezerwować terminu; rezerwację trzeba potwierdzić osobno."],
  blocked: ["Un momento, por favor. No puedo aceptar ni confirmar una reserva todavía.",
    "Одну минуту, пожалуйста. Я пока не могу принять или подтвердить запись.",
    "One moment, please. I cannot accept or confirm a booking yet.",
    "Chwileczkę, proszę. Nie mogę jeszcze zaakceptować ani potwierdzić rezerwacji."],
  closing: ["Entendido. Muchas gracias por su tiempo. Hasta luego.", "Понятно. Большое спасибо за ваше время. До свидания.", "Understood. Thank you for your time. Goodbye.", "Rozumiem. Dziękuję za poświęcony czas. Do widzenia."],
  closing_declined: [
    "Gracias por esperar. No vamos a aceptar esta propuesta. Muchas gracias por su tiempo. Hasta luego.",
    "Спасибо за ожидание. Мы не будем принимать это предложение. Большое спасибо за ваше время. До свидания.",
    "Thank you for waiting. We will not be accepting this offer. Thank you very much for your time. Goodbye.",
    "Dziękuję za cierpliwość. Nie skorzystamy z tej propozycji. Bardzo dziękuję za poświęcony czas. Do widzenia."],
  closing_unresolved: ["Lo siento, no he podido aclarar los detalles y no puedo aceptar la propuesta. Gracias por su tiempo. Hasta luego.", "К сожалению, мне не удалось уточнить детали, и я не могу принять предложение. Спасибо за ваше время. До свидания.", "Sorry, I could not clarify the details and cannot accept the proposal. Thank you for your time. Goodbye.", "Niestety nie udało się wyjaśnić szczegółów i nie mogę zaakceptować propozycji. Dziękuję za poświęcony czas. Do widzenia."],
  closing_confirmed: ["Perfecto, muchas gracias. Hasta luego.", "Отлично, большое спасибо. До свидания.", "Perfect, thank you very much. Goodbye.", "Świetnie, bardzo dziękuję. Do widzenia."],
  acknowledge: ["Gracias por la información.", "Спасибо за информацию.", "Thank you for the information.", "Dziękuję za informację."],
  evaluate: ["Gracias. Voy a comprobar la propuesta antes de aceptar nada.", "Спасибо. Я проверю предложение, прежде чем что-либо принимать.", "Thank you. I will check the proposal before accepting anything.", "Dziękuję. Sprawdzę propozycję, zanim cokolwiek zaakceptuję."],
  clean_dry_hair: ["Entendido, con el pelo limpio y seco.", "Понятно, с чистыми и сухими волосами.", "Understood, with clean, dry hair.", "Rozumiem, z czystymi i suchymi włosami."],
  echo: ["Entonces, si {pronoun} he entendido bien: {detail}. ¿Es correcto?", "Если я правильно понял: {detail}. Всё верно?", "So, if I understood you correctly: {detail}. Is that correct?", "Jeśli dobrze rozumiem: {detail}. Czy to się zgadza?"],
  echo_clarify: ["{sorry}, no {pronoun} he entendido bien. ¿{refer} a {detail}?", "Извините, я не совсем понял. Вы имеете в виду: {detail}?", "Sorry, I didn’t quite understand. Do you mean {detail}?", "Przepraszam, nie do końca rozumiem. Czy chodzi o: {detail}?"],
  clarify_service: ["¿{can} confirmar qué servicio se ofrece?", "Уточните, пожалуйста, какая услуга предлагается?", "Could you confirm which service is offered?", "Czy można potwierdzić, jaka usługa jest oferowana?"],
  clarify_name: ["¿{can} confirmar el nombre de la persona para la cita?", "Уточните, пожалуйста, на чьё имя будет запись?", "Could you confirm the name for the appointment?", "Czy można potwierdzić nazwisko osoby, dla której jest rezerwacja?"],
  clarify_date: ["¿{can} indicar el día, el mes y el año de la cita?", "Уточните, пожалуйста, день, месяц и год записи?", "Could you specify the day, month and year of the appointment?", "Czy można podać dzień, miesiąc i rok wizyty?"],
  clarify_time: ["¿{can} confirmar la hora exacta y la zona horaria de la cita?", "Уточните, пожалуйста, точное время и часовой пояс записи?", "Could you confirm the exact time and time zone of the appointment?", "Czy można potwierdzić dokładną godzinę i strefę czasową wizyty?"],
  clarify_price: ["¿{can} confirmar el precio total del corte de pelo?", "Уточните, пожалуйста, полную стоимость стрижки?", "Could you confirm the total price of the haircut?", "Czy można potwierdzić całkowitą cenę strzyżenia?"],
  clarify_conditions: ["¿{can} confirmar que no se exige depósito, pago anticipado, gastos de cancelación ni extras de pago?", "Подтвердите, пожалуйста, что нет задатка, предоплаты, платы за отмену и обязательных платных дополнительных услуг?", "Could you confirm there is no deposit, prepayment, cancellation fee or mandatory paid extras?", "Czy można potwierdzić brak zaliczki, przedpłaty, opłaty za odwołanie i obowiązkowych płatnych dodatków?"],
};
for (const reason of ["not_heard", "not_understood", "slower"] as const) {
  const ru = reason === "slower" ? "Не могли бы вы говорить немного медленнее? Вас плохо слышно." : reason === "not_understood" ? "Извините, я не совсем понял. Не могли бы вы повторить?" : "Извините, повторите, пожалуйста.";
  const pl = reason === "slower" ? "Czy można mówić trochę wolniej? Słabo słychać." : reason === "not_understood" ? "Przepraszam, nie do końca rozumiem. Czy można powtórzyć?" : "Przepraszam, czy można powtórzyć?";
  for (const tone of ["formal", "friendly"] as const) {
    const es = repeatPhrase(tone, reason);
    templates[`repeat_${reason}_${tone}`] = [es.es, ru, es.en, pl];
  }
}
const fieldLabels: Record<string, [string, string, string, string]> = {
  purpose: ["Motivo", "Цель", "Purpose", "Cel"], partySize: ["Personas", "Количество гостей", "Guests", "Liczba gości"],
  seating: ["Ubicación de la mesa", "Расположение столика", "Seating", "Miejsce stolika"], species: ["Animal", "Животное", "Animal", "Zwierzę"],
  vehicle: ["Vehículo", "Автомобиль", "Vehicle", "Pojazd"], propertyType: ["Tipo de vivienda", "Тип жилья", "Property type", "Rodzaj nieruchomości"],
  rooms: ["Habitaciones", "Комнаты", "Rooms", "Pokoje"], level: ["Nivel", "Уровень", "Level", "Poziom"],
};
const generic = {
  greeting: ["Hola, soy un asistente de inteligencia artificial. Llamo para consultar {service}. ¿Puede ayudarme?", "Здравствуйте, я помощник на основе искусственного интеллекта. Я звоню по поводу: {service}. Можете мне помочь?", "Hello, I am an AI assistant. I am calling to ask about {service}. Could you help me?", "Dzień dobry, jestem asystentem opartym na sztucznej inteligencji. Dzwonię w sprawie: {service}. Czy mogę prosić o pomoc?"],
  availability: ["Hola, soy Zeus, un asistente de inteligencia artificial y llamo en nombre de {name} para consultar {service}. Datos de la solicitud: {scope}. ¿{can} disponibilidad {windows}?", "Здравствуйте, я Зевс, помощник на основе искусственного интеллекта. Я звоню от имени {name} по поводу: {service}. Детали запроса: {scope}. Есть ли свободное время в следующие интервалы: {windows}?", "Hello, I am Zeus, an AI assistant calling on behalf of {name} to ask about {service}. Request details: {scope}. Is there availability within these windows: {windows}?", "Dzień dobry, jestem Zeus, asystent oparty na sztucznej inteligencji. Dzwonię w imieniu {name} w sprawie: {service}. Szczegóły: {scope}. Czy są wolne terminy w następujących przedziałach: {windows}?"],
  details: ["{service} el {date} a las {time}, {zone}, a nombre de {name}{staff}{duration}, {price}, {scope}, sin depósito, sin gastos de cancelación ni extras de pago obligatorios", "{service} {date} в {time}, {zone}, имя для записи: {name}{staff}{duration}, {price}, {scope}, без задатка, без платы за отмену и без обязательных платных дополнительных услуг", "{service} on {date} at {time}, {zone}, under the name {name}{staff}{duration}, {price}, {scope}, with no deposit, no cancellation fee and no mandatory paid extras", "{service} dnia {date} o {time}, {zone}, na nazwisko {name}{staff}{duration}, {price}, {scope}, bez zaliczki, opłaty za odwołanie i obowiązkowych płatnych dodatków"],
  clarify_price: ["¿{can} confirmar el coste total de esta visita o reserva y qué incluye, separado de cualquier servicio posterior?", "Уточните, пожалуйста, полную стоимость этого визита или бронирования и что в неё входит, отдельно от последующих услуг?", "Could you confirm the total charge for this visit or reservation and what it includes, separately from any later services?", "Czy można potwierdzić pełną opłatę za tę wizytę lub rezerwację i co obejmuje, oddzielnie od późniejszych usług?"],
};
const clarifyDetails = ["¿Puede confirmar que la propuesta corresponde a estos datos: {scope}?", "Подтвердите, пожалуйста, что предложение соответствует этим данным: {scope}?", "Could you confirm the proposal matches these details: {scope}?", "Czy można potwierdzić, że propozycja odpowiada tym danym: {scope}?"];
// Preserve published v1/v2 greetings, including the reviewed-name slots introduced in v2.
const greetingV2 = [
  "Hola, soy Zeus, un asistente de inteligencia artificial. Llamo{onBehalf} para consultar una cita para un corte de pelo. ¿Puede ayudarme?",
  "Здравствуйте, я Зевс, помощник на основе искусственного интеллекта. Я звоню{onBehalf}, чтобы узнать о записи на стрижку. Можете мне помочь?",
  "Hello, I am Zeus, an AI assistant. I am calling{onBehalf} to ask about a haircut appointment. Could you help me?",
  "Dzień dobry, jestem Zeus, asystent oparty na sztucznej inteligencji. Dzwonię{onBehalf} w sprawie terminu strzyżenia. Czy mogę prosić o pomoc?",
];
const genericGreetingV2 = [
  "Hola, soy Zeus, un asistente de inteligencia artificial. Llamo{onBehalf} para consultar {service}. ¿Puede ayudarme?",
  "Здравствуйте, я Зевс, помощник на основе искусственного интеллекта. Я звоню{onBehalf} по поводу: {service}. Можете мне помочь?",
  "Hello, I am Zeus, an AI assistant. I am calling{onBehalf} to ask about {service}. Could you help me?",
  "Dzień dobry, jestem Zeus, asystent oparty na sztucznej inteligencji. Dzwonię{onBehalf} w sprawie: {service}. Czy mogę prosić o pomoc?",
];
// New versions omit product branding while preserving all previously stored phrase rows.
const withoutAssistantName = (text: string) => text
  .replace("soy Zeus, un asistente", "soy un asistente")
  .replace("я Зевс, помощник", "я помощник")
  .replace("I am Zeus, an AI assistant", "I am an AI assistant")
  .replace("jestem Zeus, asystent oparty", "jestem asystentem opartym");
const availabilityV3 = [
  "¿{can} disponibilidad para un corte de pelo {windows}?",
  "Есть ли свободное время для стрижки в следующие интервалы: {windows}?",
  "Is there availability for a haircut within these windows: {windows}?",
  "Czy są wolne terminy strzyżenia w następujących przedziałach: {windows}?",
];
const genericAvailabilityV3 = [
  "¿{can} disponibilidad para {service} {windows}? Datos de la solicitud: {scope}.",
  "Есть ли свободное время по запросу «{service}» в следующие интервалы: {windows}? Детали запроса: {scope}.",
  "Is there availability for {service} within these windows: {windows}? Request details: {scope}.",
  "Czy są wolne terminy na {service} w następujących przedziałach: {windows}? Szczegóły: {scope}.",
];
const haircutBooking = {
  booking_details: ["Por favor, reserve una cita para un corte de pelo{contact}.", "Запишите, пожалуйста, на стрижку{contact}.", "Please book a haircut appointment{contact}.", "Proszę zarezerwować strzyżenie{contact}."],
  booking_name: [" a nombre de {name}", " на имя {name}", " under the name {name}", " na nazwisko {name}"],
  booking_phone: [", teléfono de contacto: {phone}", ", телефон для связи: {phone}", ", contact phone: {phone}", ", telefon kontaktowy: {phone}"],
};
const haircutDetailsV3 = ["{details}",
  "стрижка {date} в {time}, имя для записи: {name}{staff}{duration}, {price}",
  "a haircut on {date} at {time}, under the name {name}{staff}{duration}, {price}",
  "strzyżenie dnia {date} o {time}, na nazwisko {name}{staff}{duration}, {price}"];
const clarifyTimeV2 = ["¿{can} confirmar la hora exacta de la cita?", "Уточните, пожалуйста, точное время записи?",
  "Could you confirm the exact time of the appointment?", "Czy można potwierdzić dokładną godzinę wizyty?"];
const bookingPhrasesV2: Record<string, readonly string[]> = {
  readback: [
    "Entonces, {details}. ¿Es correcto?",
    "Правильно понимаю: {details}?",
    "Just to check: {details}. Is that correct?",
    "Dla pewności: {details}. Czy wszystko się zgadza?",
  ],
  acceptance: [
    "Perfecto, reserve la cita para {details}, por favor.",
    "Отлично, запишите, пожалуйста: {details}.",
    "Great, please book the appointment for {details}.",
    "Świetnie, proszę zarezerwować termin: {details}.",
  ],
  confirm_details: [
    "¿Son correctos los datos que acabo de leer?",
    "Я правильно перечислил детали записи?",
    "Did I get those appointment details right?",
    "Czy podane przeze mnie szczegóły wizyty są poprawne?",
  ],
};
const phraseVersion = (key: string, namespace?: string) => key === "greeting" || key === "availability" || key === "details" && namespace === "haircut" ? 3 : key === "window" || key === "details" || key === "clarify_time" || Object.hasOwn(bookingPhrasesV2, key) ? 2 : 1;
export const dialoguePhraseCatalog: readonly PhraseEntry[] = conversationTemplates.flatMap(profile => {
  const entries: Record<string, readonly string[]> = { ...templates, ...(profile.id === "haircut" ? haircutBooking : generic), requirements: [...profile.requirements], clarify_details: clarifyDetails };
  for (const field of profile.fields) entries[`field_${field.key.toLowerCase()}`] = fieldLabels[field.key]!;
  const legacy = Object.entries(entries).filter(([key]) => profile.id === "haircut" || key !== "clean_dry_hair").flatMap(([key, texts]) =>
    languages.map((language, i) => ({ id: `${profile.id}.${key}`, version: 1, language, template: texts[i]!.replaceAll("{service}", profile.service[i]!) })));
  // Keep published templates intact; ordinary speech uses business-local dates/times without zone labels.
  const localTimes = ["window", "details"].flatMap(key => languages.map((language, i) => ({
    id: `${profile.id}.${key}`, version: 2, language,
    template: entries[key]![i]!.replaceAll("{service}", profile.service[i]!)
      .replaceAll(", {zone}", "").replaceAll(", {startZone}", "").replaceAll(", {endZone}", ""),
  })));
  // Haircut replies no longer assert absent fees or ask a conditions questionnaire.
  const haircutDetails = profile.id === "haircut" ? languages.map((language, i) => ({
    id: "haircut.details", version: 3, language, template: haircutDetailsV3[i]!,
  })) : [];
  const greetings = profile.id === "haircut" ? greetingV2 : genericGreetingV2;
  const bookingPhrases = Object.entries(bookingPhrasesV2).flatMap(([key, texts]) => languages.map((language, i) => ({
    id: `${profile.id}.${key}`, version: 2, language, template: texts[i]!,
  })));
  return [...legacy, ...localTimes, ...haircutDetails, ...bookingPhrases, ...languages.flatMap((language, i) => {
    const greeting = greetings[i]!.replaceAll("{service}", profile.service[i]!);
    const availability = entries.availability![i]!.replaceAll("{service}", profile.service[i]!);
    return [
      { id: `${profile.id}.clarify_time`, version: 2, language, template: clarifyTimeV2[i]! },
      { id: `${profile.id}.greeting`, version: 2, language, template: greeting },
      { id: `${profile.id}.greeting`, version: 3, language, template: withoutAssistantName(greeting) },
      { id: `${profile.id}.availability`, version: 2, language, template: withoutAssistantName(availability) },
      { id: `${profile.id}.availability`, version: 3, language,
        template: (profile.id === "haircut" ? availabilityV3 : genericAvailabilityV3)[i]!.replaceAll("{service}", profile.service[i]!) },
    ];
  })];
});
const phraseIndex = new Map(dialoguePhraseCatalog.map(row => [`${row.id}:${row.version}:${row.language}`, row.template]));
export const defaultPhraseLookup: PhraseLookup = (id, version, language) => {
  const text = phraseIndex.get(`${id}:${version}:${language}`);
  if (text === undefined) throw new Error("Missing dialogue phrase");
  return text;
};
export const dialogueLanguage = (plan: Plan): DialogueLanguage => plan.request.language ?? "es-ES";
function interpolate(template: string, slots: Record<string, string>): string {
  return TextSchema.parse(template.replace(/\{([A-Za-z]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(slots, key)) throw new Error("Missing dialogue phrase slot");
    return slots[key]!;
  }));
}
const moneyAmount = (minor: number) => { const digits = String(minor).padStart(3, "0"); return `${digits.slice(0, -2)}.${digits.slice(-2)}`; };
function date(value: string, language: DialogueLanguage): string {
  return language === "es-ES" ? spanish.dateSpanish(value) : new Intl.DateTimeFormat(language, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}
export function renderReply(key: string, plan: Plan, slots: Record<string, string> = {}, lookup: PhraseLookup = defaultPhraseLookup): RenderedReply {
  const language = dialogueLanguage(plan);
  const namespace = templateForRequest(plan.request)?.id ?? "haircut";
  const id = `${namespace}.${key}`;
  const version = phraseVersion(key, namespace);
  const render = (locale: DialogueLanguage) => {
    const name = plan.request.bookingName.trim();
    const values = key === "greeting" ? { onBehalf: name
      ? " " + interpolate(lookup(`${namespace}.on_behalf`, 1, locale), { name: speechSlot(name) }) : "" } : slots;
    return interpolate(lookup(id, version, locale), values);
  };
  return { phrase: { id, version, language }, text: render(language), translationEn: render("en-US") };
}
/** Only reviewed/evidenced data reaches slots; model-authored speech and phrase identifiers are never accepted. */
export function renderAction(candidate: CandidateAction, plan: Plan, offer: Offer | null, lookup: PhraseLookup = defaultPhraseLookup, confirmed = false): RenderedReply {
  const language = dialogueLanguage(plan);
  const tu = friendly(plan.request.tone ?? "formal");
  const render = (key: string, slots: Record<string, string> = {}) => renderReply(key, plan, slots, lookup);
  const profile = templateForRequest(plan.request);
  const namespace = profile?.id ?? "haircut";
  const localized = (key: string, locale: DialogueLanguage, slots: Record<string, string> = {}) => interpolate(lookup(`${namespace}.${key}`, phraseVersion(key, namespace), locale), slots);
  const name = plan.request.bookingName;
  const scope = (values: Offer["templateDetails"], locale: DialogueLanguage) => {
    const languageIndex = languages.indexOf(locale);
    return (profile?.fields ?? []).map(field => {
      const value = values?.[field.key];
      if (value == null) throw new Error("Missing evidenced template detail");
      const label = localized(`field_${field.key.toLowerCase()}`, locale);
      const option = field.options?.find(option => option.value === value);
      if (field.kind === "choice" && !option) throw new Error("Unknown template option");
      return `${label}: ${option ? option.label[languageIndex] : speechSlot(String(value))}`;
    }).join("; ");
  };
  const details = (locale: DialogueLanguage) => {
    if (!offer) throw new Error("Offer required for dialogue phrase");
    if (locale === "es-ES" && namespace === "haircut") return spanish.offerDetails(plan as ApprovedPlan, offer);
    return localized("details", locale, { date: date(offer.appointment.localDate, locale), time: offer.appointment.localTime,
      name: speechSlot(name), scope: scope(offer.templateDetails, locale),
      staff: offer.staffName ? localized("staff", locale, { name: speechSlot(offer.staffName) }) : "",
      duration: offer.durationMinutes === null ? "" : localized("duration", locale, { minutes: String(offer.durationMinutes) }),
      price: offer.price ? localized("price", locale, { amount: moneyAmount(offer.price.amountMinor) }) : localized("price_unknown", locale) });
  };
  // Some slot values also require localization. Render each language independently for faithful English UI text.
  const bilingual = (key: string, slots: (locale: DialogueLanguage) => Record<string, string>): RenderedReply => ({
    phrase: { id: `${namespace}.${key}`, version: phraseVersion(key, namespace), language }, text: localized(key, language, slots(language)), translationEn: localized(key, "en-US", slots("en-US")),
  });
  switch (candidate.action) {
    case "ask_availability": return bilingual("availability", locale => ({ name: speechSlot(name), scope: scope(plan.request.templateDetails, locale), can: tu ? "Tienes" : "Tiene", windows: plan.request.availability.map(w => localized("window", locale, {
      start: date(w.start.localDate, locale), startTime: w.start.localTime,
      end: date(w.end.localDate, locale), endTime: w.end.localTime,
    })).join(locale === "es-ES" ? "; o bien " : "; ") }));
    case "ask_requirements": return render("requirements");
    case "read_back": case "accept_offer": return bilingual(candidate.action === "read_back" ? "readback" : "acceptance", locale => ({ details: details(locale), can: tu ? "Puedes" : "Puede" }));
    case "clarify": {
      const fields = [...new Set(candidate.missing)].filter(field => namespace !== "haircut" || field !== "conditions");
      if (namespace === "haircut" && (fields.includes("name") && name.trim() || !fields.length)) {
        return bilingual("booking_details", locale => ({ contact:
          (name.trim() ? " " + localized("booking_name", locale, { name: speechSlot(name.trim()) }) : "")
          + (plan.request.shareableContact.phone ? localized("booking_phone", locale, { phone: speechSlot(plan.request.shareableContact.phone) }) : ""),
        }));
      }
      return bilingual("clarification", locale => ({ questions: fields.map(field => localized(`clarify_${field}`, locale, { can: tu ? "Puedes" : "Puede", scope: scope(plan.request.templateDetails, locale) })).join(" ") }));
    }
    case "end_call": return render(confirmed ? "closing_confirmed" : candidate.reason === "unresolved" ? "closing_unresolved" : "closing");
    case "evaluate_offer": return render("evaluate");
    case "record_business_confirmation": return render("acknowledge");
    case "record_note": return render("clean_dry_hair");
    case "repeat": return render(`repeat_${candidate.reason}_${tu ? "friendly" : "formal"}`);
    case "echo_detail": return bilingual(candidate.mode === "clarify" ? "echo_clarify" : "echo", locale => {
      if (!offer) throw new Error("Offer required for echo");
      let detail: string;
      switch (candidate.field) {
        case "date": detail = offer.appointment.localDate; break;
        case "time": detail = `${offer.appointment.localDate}, ${offer.appointment.localTime}`; break;
        case "name": detail = speechSlot(offer.bookingName); break;
        case "staff": if (!offer.staffName) throw new Error("Missing staff"); detail = locale === "es-ES" ? `con ${speechSlot(offer.staffName)}` : speechSlot(offer.staffName); break;
        case "price": if (!offer.price) throw new Error("Missing price"); detail = `${moneyAmount(offer.price.amountMinor)}${locale === "es-ES" ? " euros" : " EUR"}`; break;
      }
      return { detail, pronoun: tu ? "te" : "le", sorry: tu ? "Perdona" : "Perdone", refer: tu ? "Te refieres" : "Se refiere" };
    });
    default: throw new Error("Unsupported localized dialogue action");
  }
}
export const renderReadback = (plan: ApprovedPlan, offer: Offer) => renderAction({ action: "read_back", offerId: offer.id, offerVersion: offer.version }, plan, offer).text;
export const renderAcceptance = (plan: ApprovedPlan, offer: Offer) => renderAction({ action: "accept_offer", offerId: offer.id, offerVersion: offer.version }, plan, offer).text;
