-- Применить на уже существующей базе (не пересоздаёт таблицы, только добавляет)

-- 1. Явный тип заказа вместо угадывания по тексту/пустым полям на фронте.
--    'site' — сайт (лендинг/многостраничник/магазин/особый случай),
--    'bot'  — Telegram-бот / мини-апп.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'site';
CREATE INDEX IF NOT EXISTS idx_orders_order_type ON orders(order_type);

-- Бэкафилл существующих заказов по уже применявшейся на фронте эвристике,
-- чтобы старые боты не потерялись после включения новой логики.
UPDATE orders SET order_type = 'bot'
WHERE order_type = 'site'
  AND (
    (bot_username IS NOT NULL OR bot_link IS NOT NULL)
    AND site_domain IS NULL AND site_url IS NULL
  );

-- 2. Внутренние заметки админа — НЕ уходят клиенту (в отличие от status_comment).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- 3. История смены статусов заказа.
CREATE TABLE IF NOT EXISTS order_status_history (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status      SMALLINT NOT NULL,
    changed_by  TEXT,              -- email админа; NULL = системное изменение (напр. вебхук оплаты)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at);
