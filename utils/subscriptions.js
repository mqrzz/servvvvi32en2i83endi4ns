async function grantOrRenewSubscription(client, { orderId, userId, tariff, amount, now }) {
  const { rows: subRows } = await client.query(
    `SELECT * FROM service_subscriptions WHERE order_id = $1 FOR UPDATE`,
    [orderId]
  );
  const existing = subRows[0] || null;
  const hasActive = existing && existing.status === 'active' && new Date(existing.period_end) > now;
  const tariffKey = tariff || (existing ? existing.tariff : 'basic');
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
