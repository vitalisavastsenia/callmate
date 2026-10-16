import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMockConfirmation, verifyMockReadback } from '../dist/mock-confirmation.js';
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

test('bounded mock verifiers clarify questions that otherwise match affirmations', () => {
  for (const [language, originalText] of [
    ['es-ES', '¿Confirmado?'],
    ['es-ES', '¿La reserva está confirmada?'],
    ['es-ES', '¿Confirmado'],
    ['es-ES', 'Confirmado?'],
    ['ru-RU', 'Запись подтверждена?'],
    ['en-US', 'The appointment is booked?'],
    ['pl-PL', 'Rezerwacja jest potwierdzona?'],
  ]) {
    const context = { evidence: [{ language, originalText }] };
    assert.equal(verifyMockConfirmation(context), 'ambiguous', originalText);
    assert.equal(verifyMockReadback(context), 'ambiguous', originalText);
  }
});

for (const [language, invitation, corrections] of [
  ['ru-RU', 'Да всё так вас записать в это время', [
    'Вас записать в это время?', 'Да всё так, но цена другая, вас записать в это время?',
    'Наверное всё так вас записать в это время',
  ]],
  ['es-ES', 'Sí, todo correcto. ¿Le reservo la cita a esa hora?', [
    '¿Le reservo la cita a esa hora?', 'Sí, todo correcto, pero son 60 euros. ¿Le reservo la cita a esa hora?',
  ]],
  ['en-US', "Yes, that's all correct. Shall I book you for that time?", [
    'Shall I book you for that time?', "Yes, that's all correct, but the price changed. Shall I book you for that time?",
  ]],
  ['pl-PL', 'Tak, wszystko się zgadza. Czy zapisać panią na tę godzinę?', [
    'Czy zapisać panią na tę godzinę?', 'Tak, wszystko się zgadza, ale cena jest inna. Czy zapisać panią na tę godzinę?',
  ]],
]) test(`bounded mock readback: ${language} distinguishes agreement with an invitation from a completed booking`, () => {
  const context = originalText => ({ evidence: [{ language, originalText }] });
  assert.equal(verifyMockReadback(context(invitation)), 'affirmed');
  assert.equal(verifyMockConfirmation(context(invitation)), 'ambiguous');
  for (const text of corrections) assert.equal(verifyMockReadback(context(text)), 'ambiguous', text);
  assert.equal(verifyMockReadback({ evidence: [] }), 'ambiguous');
  assert.equal(verifyMockReadback({ evidence: [...context(invitation).evidence, ...context(invitation).evidence] }), 'ambiguous');
});
