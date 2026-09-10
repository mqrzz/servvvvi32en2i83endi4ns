-- =====================================================
-- MIGRATION: один отзыв на заказ
-- Раньше не было ни проверки на уровне приложения (order.reviewed),
-- ни ограничения в БД — можно было отправить несколько отзывов на один
-- и тот же заказ (двойной клик, повторная отправка формы).
-- Сначала подчищаем возможные существующие дубликаты (оставляем самый
-- ранний отзыв на каждый заказ), потом ставим уникальный индекс.
-- Применять: psql -U <user> -d <db> -f migration_reviews_unique_order.sql
-- =====================================================

DELETE FROM reviews r
USING reviews r2
WHERE r.order_id = r2.order_id
  AND r.created_at > r2.created_at;

DROP INDEX IF EXISTS idx_reviews_order;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_order_unique ON reviews(order_id);
