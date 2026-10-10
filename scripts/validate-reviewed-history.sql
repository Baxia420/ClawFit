-- Supply verified jobayer_user_id and cici_user_id as psql -v variables.
BEGIN READ ONLY;

SELECT user_id, count(*) AS person_meals,
       count(*) FILTER (WHERE calories_best IS NULL) AS unknown_calories,
       count(*) FILTER (WHERE protein_g IS NULL OR carbs_g IS NULL OR fat_g IS NULL) AS unknown_macros
FROM meals
WHERE user_id IN (:'jobayer_user_id'::uuid, :'cici_user_id'::uuid)
  AND idempotency_key LIKE 'clawfit-whatsapp-history-v1:%'
GROUP BY user_id ORDER BY user_id;

SELECT m.user_id, to_char(m.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day,
       count(*) AS meal_count,
       CASE WHEN count(*) = count(m.calories_best) THEN sum(m.calories_best) END AS total_calories,
       sum(m.calories_best) AS known_calorie_subtotal,
       CASE WHEN count(*) = count(m.protein_g) THEN sum(m.protein_g) END AS total_protein_g,
       sum(m.protein_g) AS known_protein_subtotal,
       CASE WHEN count(*) = count(m.carbs_g) THEN sum(m.carbs_g) END AS total_carbs_g,
       CASE WHEN count(*) = count(m.fat_g) THEN sum(m.fat_g) END AS total_fat_g,
       CASE WHEN count(*) = count(m.fiber_g) THEN sum(m.fiber_g) END AS total_fiber_g
FROM meals m
WHERE m.user_id IN (:'jobayer_user_id'::uuid, :'cici_user_id'::uuid)
  AND m.idempotency_key LIKE 'clawfit-whatsapp-history-v1:%'
GROUP BY m.user_id, day ORDER BY m.user_id, day;

SELECT m.user_id, count(i.id) AS food_items
FROM meals m LEFT JOIN meal_items i ON i.meal_id = m.id
WHERE m.user_id IN (:'jobayer_user_id'::uuid, :'cici_user_id'::uuid)
  AND m.idempotency_key LIKE 'clawfit-whatsapp-history-v1:%'
GROUP BY m.user_id ORDER BY m.user_id;

SELECT user_id, idempotency_key, count(*)
FROM meals GROUP BY user_id, idempotency_key HAVING count(*) > 1;

SELECT raw_user_text::jsonb #>> '{historicalImport,sharedEventId}' AS source_event,
       count(*) AS person_rows, array_agg(DISTINCT user_id) AS owners
FROM meals
WHERE user_id IN (:'jobayer_user_id'::uuid, :'cici_user_id'::uuid)
  AND idempotency_key LIKE 'clawfit-whatsapp-history-v1:%'
GROUP BY source_event HAVING count(*) > 1 ORDER BY source_event;

SELECT id, user_id, occurred_at, label
FROM meals
WHERE user_id IN (:'jobayer_user_id'::uuid, :'cici_user_id'::uuid)
  AND idempotency_key LIKE 'clawfit-whatsapp-history-v1:%'
  AND raw_user_text::jsonb #>> '{historicalImport,timeBasis}' = 'date_only_noon_anchor'
ORDER BY user_id, occurred_at;

COMMIT;
