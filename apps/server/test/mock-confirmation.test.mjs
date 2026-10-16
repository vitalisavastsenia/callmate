import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMockConfirmation } from '../dist/mock-confirmation.js';
const verdict = (language, originalText) => verifyMockConfirmation({ evidence: [{ language, originalText }] });
for (const [language, positive, negative] of [
  ['ru-RU', [
    'Да всё так спасибо', 'Да, записал вас', 'Запись подтверждена.',
    'Да подтверждаю', 'Подтверждаю', 'Да, я подтверждаю запись, спасибо!',
    'Да я уже подтвердил это', 'Я уже подтвердила запись', 'Да, уже подтвердили это.',
  ], [
    'Да, но цена 60 евро', 'Нет, запись не подтверждена', 'Наверное да', 'Да? Нет!', 'Не записал вас',
    'Да, не подтверждаю', 'Да, я ещё не подтвердил это', 'Я уже не подтверждаю запись',
    'Да подтверждаю, но время другое', 'Да я уже подтвердил это, но цена 60 евро',
    'Наверное подтверждаю', 'Подтверждаю после оплаты', 'Вы подтверждаете запись?',
  ]],
  ['es-ES', [
    'Sí, todo correcto, gracias', 'La reserva está confirmada', 'Sí, confirmo', 'Confirmo la cita.',
    'Sí, yo confirmo la reserva, muchas gracias', 'Sí, ya lo he confirmado', 'Ya lo confirmé',
    'Sí, ya la confirmé.', 'He confirmado la reserva',
  ], [
    'Sí, pero son 60 euros', 'No está confirmada', 'Quizás sí', 'No confirmo', 'Sí, no lo he confirmado',
    'Sí, ya no lo confirmo', 'Sí, confirmo, pero a otra hora', 'Ya lo he confirmado, pero son 60 euros',
    'Quizás lo confirme', 'Confirmo después del pago', '¿Confirma la cita?',
  ]],
  ['en-US', [
    'Yes, that is correct, thank you', 'The appointment is booked', "Yes, that's correct", 'Yes, I confirm',
    'I confirm the booking, thanks.', 'Yes, I already confirmed that', 'I have already confirmed it',
    "Yes, I've already confirmed it, thank you", 'I confirmed the reservation',
  ], [
    'Yes, but the price is 60', 'The appointment is not booked', 'I think so', 'No, yes',
    'I do not confirm', "Yes, I haven't confirmed it", 'I already confirmed that I cannot book it',
    'Yes, I confirm, but at another time', 'I already confirmed it, but the price is 60',
    'I might confirm', 'I confirm after payment', 'Can I confirm the booking?',
  ]],
  ['pl-PL', [
    'Tak, wszystko się zgadza, dziękuję', 'Rezerwacja jest potwierdzona', 'Tak, potwierdzam',
    'Potwierdzam wizytę.', 'Tak, ja potwierdzam rezerwację, dziękuję', 'Tak, już to potwierdziłem',
    'Już to potwierdziłam', 'Tak, już potwierdziłam rezerwację.', 'Potwierdziłem to',
  ], [
    'Tak, ale cena to 60', 'Rezerwacja nie jest potwierdzona', 'Chyba tak', 'Nie potwierdzam',
    'Tak, jeszcze nie potwierdziłem', 'Już nie potwierdzam rezerwacji',
    'Tak, potwierdzam, ale o innej godzinie', 'Już to potwierdziłem, ale cena to 60',
    'Może potwierdzę', 'Potwierdzam po zapłacie', 'Czy potwierdza pan rezerwację?',
  ]],
]) test(`bounded mock confirmation: ${language} preserves negation, changed facts and uncertainty`, () => {
  for (const text of positive) assert.equal(verdict(language, text), 'affirmed', text);
  for (const text of negative) assert.equal(verdict(language, text), 'ambiguous', text);
});
