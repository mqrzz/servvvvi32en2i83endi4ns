-- Переход "Обслуживания" с 4 колонок на orders (support_active/support_tariff/
-- support_started_at/support_expires_at — снепшот без истории, без
-- server-side проверки лимита заявок) на отдельные таблицы:
--   service_subscriptions — текущая подписка на заказ (одна активная на заказ);
--   subscription_renewals — история продлений (кто когда продлил, по какому тарифу).
-- Колонки support_* на orders НЕ удаляем этой миграцией — оставляем как есть
-- (ничего с ними не делаем, дальше они бэкендом не используются). Удалить
-- их отдельной миграцией уже после того, как убедимся, что всё поехало
-- на новую модель.

CREATE TABLE IF NOT EXISTS service_subscriptions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tariff              TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    tickets_used        INT NOT NULL DEFAULT 0,
    auto_renew          BOOLEAN NOT NULL DEFAULT FALSE,
    expiry_notified_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_subscriptions_order ON service_subscriptions(order_id);
CREATE INDEX IF NOT EXISTS idx_service_subscriptions_user ON service_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS subscription_renewals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID NOT NULL REFERENCES service_subscriptions(id) ON DELETE CASCADE,
    tariff          TEXT NOT NULL,
    amount          NUMERIC(10,2) NOT NULL,
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    paid_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_renewals_sub ON subscription_renewals(subscription_id);

ALTER TABLE service_tickets ADD COLUMN IF NOT EXISTS subscription_id UUID;
DO $$ BEGIN
  ALTER TABLE service_tickets
    ADD CONSTRAINT fk_service_tickets_subscription
    FOREIGN KEY (subscription_id) REFERENCES service_subscriptions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_service_tickets_subscription ON service_tickets(subscription_id);

DO $$ BEGIN
  CREATE TRIGGER trg_service_subscriptions_updated BEFORE UPDATE ON service_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Бэкфилл: у кого сейчас support_active=TRUE на заказе — заводим ему
-- текущую подписку в новой таблице (period_start/end и тариф берём из тех
-- же support_* колонок, tickets_used выставляем по факту уже созданных
-- заявок billing='subscription' с created_at внутри этого периода —
-- лучшее приближение, т.к. раньше периоды не хранились как отдельные
-- отрезки времени).
INSERT INTO service_subscriptions (order_id, user_id, tariff, status, period_start, period_end, tickets_used)
SELECT
  o.id,
  o.user_id,
  COALESCE(o.support_tariff, 'basic'),
  'active',
  COALESCE(o.support_started_at, now() - interval '30 days'),
  o.support_expires_at,
  (
    SELECT COUNT(*) FROM service_tickets st
    WHERE st.order_id = o.id
      AND st.billing = 'subscription'
      AND st.created_at >= COALESCE(o.support_started_at, now() - interval '30 days')
  )
FROM orders o
WHERE o.support_active = TRUE
  AND o.support_expires_at IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;
