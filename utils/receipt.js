// Чек 54-ФЗ для ЮKassa. Включается переменной YOOKASSA_RECEIPT=1 (в личном кабинете ЮKassa должна быть подключена «Чеки от ЮKassa»
// или онлайн-касса). Без неё платежи создаются как раньше.
//   YOOKASSA_VAT_CODE    1 = без НДС (по умолчанию), 2 = 0%, 3 = 10%, 4 = 20%, 5 = 10/110, 6 = 20/120
//   YOOKASSA_TAX_SYSTEM  1 общая, 2 УСН доход, 3 УСН доход-расход, 4 ЕНВД, 5 ЕСХН, 6 патент (если в кассе одна система, можно не задавать)
function receiptOn() { return process.env.YOOKASSA_RECEIPT === '1'; }

function buildReceipt(email, description, amount, mode) {
  if (!receiptOn()) return null;
  const to = String(email || '').trim();
  if (!to) return null;
  const r = {
    customer: { email: to },
    items: [{
      description: String(description).slice(0, 128),
      quantity: '1.00',
      amount: { value: Number(amount).toFixed(2), currency: 'RUB' },
      vat_code: Number(process.env.YOOKASSA_VAT_CODE || 1),
      payment_subject: 'service',
      payment_mode: mode || 'full_payment',
    }],
  };
  if (process.env.YOOKASSA_TAX_SYSTEM) r.tax_system_code = Number(process.env.YOOKASSA_TAX_SYSTEM);
  return r;
}
module.exports = { receiptOn, buildReceipt };
