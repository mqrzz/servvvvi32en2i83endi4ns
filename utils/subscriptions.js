// Общая логика выдачи/продления подписки на обслуживание — раньше жила
// ТОЛЬКО внутри вебхука оплаты (routes/payments.js). Ручные кнопки админки
// "Активировать"/"Продлить" (admin/orders.html) писали напрямую в колонки
// orders.support_* мимо этой логики — то есть после перехода на таблицу
// service_subscriptions ручная активация админом переставала реально
// работать (клиенту показывалось "подключено", а сервер при создании
// заявки всё равно не находил активной подписки и требовал оплату).
// Вынесено сюда, чтобы обе точки входа (оплата и админ) использовали
// ровно один и тот же код, а не третью копию той же формулы периода.
//
// client — pool или client активной транзакции с методом .query.
// { orderId, userId, tariff, amount, now } — amount=0 для ручной выдачи
// админом (не создаёт настоящего платежа, но пишется в subscription_renewals
// для истории, чтобы в логе было видно, что продление было "комплиментарным").
async function grantOrRenewSubscription(client, { orderId, userId, tariff, amount, now }) {
  const { rows: subRows } = await client.query(
    `SELECT * FROM service_subscriptions WHERE order_id = $1 FOR UPDATE`,
    [orderId]
  );
  const existing = subRows[0] || null;
  const hasActive = existing && existing.status === 'active' && new Date(existing.period_end) > now;
  const tariffKey = tariff || (existing ? existing.tariff : 'basic');
  // Продление встык с текущим периодом, если он ещё не кончился (иначе
  // часть уже оплаченного/выданного времени пропадала бы впустую).
  const periodStart = hasActive ? new Date(existing.period_end) : now;
  const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  let subscriptionId;
  if (existing) {
    await client.query(
      `UPDATE service_subscriptions SET tariff=$1, status='active', period_start=$2, period_end=$3,
       tickets_used=0, expiry_notified_at=NULL WHERE id=$4`,
      [tariffKey, periodStart.toISOString(), periodEnd.toISOString(), existing.id]
    );
    subscriptionId = existing.id;
  } else {
    const { rows } = await client.query(
      `INSERT INTO service_subscriptions (order_id, user_id, tariff, status, period_start, period_end)
       VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`,
      [orderId, userId, tariffKey, periodStart.toISOString(), periodEnd.toISOString()]
    );
    subscriptionId = rows[0].id;
  }
  await client.query(
    `INSERT INTO subscription_renewals (subscription_id, tariff, amount, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5)`,
    [subscriptionId, tariffKey, amount, periodStart.toISOString(), periodEnd.toISOString()]
  );

  return { subscriptionId, tariff: tariffKey, periodStart, periodEnd };
}

module.exports = { grantOrRenewSubscription };
