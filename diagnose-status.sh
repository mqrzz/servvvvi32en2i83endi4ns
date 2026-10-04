#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
: "${DATABASE_URL:?DATABASE_URL не найден в .env}"

echo "=== 1. Сервисы и как они проверяются ==="
psql "$DATABASE_URL" -c "SELECT id, name, check_type, check_url, status FROM status_services ORDER BY sort_order;"

echo; echo "=== 2. Проваленные проверки за 24ч: КАКАЯ ошибка, какой код, сколько мс ==="
psql "$DATABASE_URL" -c "SELECT s.name, c.status_code, c.latency_ms, left(c.error,90) AS error, to_char(c.checked_at,'DD.MM HH24:MI') AS at
  FROM status_checks c JOIN status_services s ON s.id=c.service_id
  WHERE c.ok=false AND c.checked_at > now()-interval '24 hours' ORDER BY c.checked_at DESC LIMIT 40;"

echo; echo "=== 3. Сводка по сервисам за 24ч: сколько проверок, сколько провалов, задержка ==="
psql "$DATABASE_URL" -c "SELECT s.name, count(*) AS checks, count(*) FILTER (WHERE NOT c.ok) AS fails,
  round(100.0*count(*) FILTER (WHERE NOT c.ok)/count(*),1) AS fail_pct,
  round(avg(c.latency_ms)) AS avg_ms, max(c.latency_ms) AS max_ms
  FROM status_checks c JOIN status_services s ON s.id=c.service_id
  WHERE c.checked_at > now()-interval '24 hours' GROUP BY s.name ORDER BY fails DESC;"

echo; echo "=== 4. Что Telegram сам говорит про вебхук бота ==="
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
  echo "(смотри last_error_message, last_error_date, pending_update_count; если last_error_date свежий — Telegram реально не может достучаться до Vercel)"
else echo "TELEGRAM_BOT_TOKEN не задан в .env бэкенда — это САМО по себе причина красного статуса бота"; fi

echo; echo "=== 5. Живые замеры URL проверок (5 раз подряд, время ответа) ==="
psql "$DATABASE_URL" -At -c "SELECT name||'|'||check_url FROM status_services WHERE check_url IS NOT NULL AND check_url<>'';" | while IFS='|' read -r name url; do
  echo "--- $name → $url"
  for i in 1 2 3 4 5; do
    curl -o /dev/null -s -m 10 -w "  #$i  http=%{http_code}  dns=%{time_namelookup}s  connect=%{time_connect}s  total=%{time_total}s\n" "$url" || echo "  #$i  ОШИБКА curl (таймаут/сеть)"
    sleep 1
  done
done

echo; echo "=== 6. Что бэкенд писал в лог про монитор за последние 2 часа ==="
journalctl -u antviz-backend --since "-2h" --no-pager 2>/dev/null | grep -i "statusMonitor\|notifyTelegram\|автоинцидент" | tail -30
