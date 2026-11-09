-- =====================================================================
--  ЛОГІСТИКА — склади, види постачання, рейси доставки (синтетичні дані)
--  Запуск (після 01–04):  psql -U postgres -d analytics_db -f 05_logistics.sql
-- =====================================================================

DROP TABLE IF EXISTS deliveries   CASCADE;
DROP TABLE IF EXISTS depots       CASCADE;
DROP TABLE IF EXISTS supply_types CASCADE;

-- Види постачання + норма витрат на 1 особу на добу (кг) — для розрахунку потреби
CREATE TABLE supply_types (
    code           VARCHAR(16) PRIMARY KEY,
    name_uk        VARCHAR(64) NOT NULL,
    norm_kg_day    NUMERIC(6,2) NOT NULL,
    interval_days  INT         NOT NULL,   -- типовий інтервал підвезення
    ord            INT         NOT NULL
);

-- Склади / пункти забезпечення
--   kind: base — базовий (тиловий) склад, forward — передовий пункт забезпечення
CREATE TABLE depots (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(128) NOT NULL,
    kind       VARCHAR(8)   NOT NULL CHECK (kind IN ('base','forward')),
    region_id  INT          NOT NULL REFERENCES regions(id),
    lat        NUMERIC(8,5) NOT NULL,
    lon        NUMERIC(8,5) NOT NULL
);

-- Рейси доставки
--   status: delivered — вчасно, delayed — із запізненням (>2 год),
--           in_transit — у дорозі, lost — втрачено (знищено / не доставлено)
CREATE TABLE deliveries (
    id               SERIAL PRIMARY KEY,
    depot_id         INT          NOT NULL REFERENCES depots(id),
    unit_id          INT          NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    supply_type      VARCHAR(16)  NOT NULL REFERENCES supply_types(code),
    transport        VARCHAR(8)   NOT NULL CHECK (transport IN ('truck','rail')),
    planned_qty_t    NUMERIC(9,2) NOT NULL CHECK (planned_qty_t > 0),
    delivered_qty_t  NUMERIC(9,2) NOT NULL DEFAULT 0 CHECK (delivered_qty_t >= 0),
    distance_km      NUMERIC(7,1) NOT NULL,
    depart_time      TIMESTAMPTZ  NOT NULL,
    planned_arrival  TIMESTAMPTZ  NOT NULL,
    arrive_time      TIMESTAMPTZ,
    status           VARCHAR(12)  NOT NULL CHECK (status IN ('delivered','delayed','in_transit','lost'))
);

CREATE INDEX idx_deliv_time   ON deliveries(depart_time);
CREATE INDEX idx_deliv_unit   ON deliveries(unit_id);
CREATE INDEX idx_deliv_depot  ON deliveries(depot_id);
CREATE INDEX idx_deliv_type   ON deliveries(supply_type);

INSERT INTO supply_types (code, name_uk, norm_kg_day, interval_days, ord) VALUES
 ('ammo',    'Боєприпаси',          7.0, 3, 1),
 ('fuel',    'ПММ',                 6.0, 3, 2),
 ('food',    'Продовольство',       2.0, 4, 3),
 ('water',   'Вода',                4.0, 2, 4),
 ('medical', 'Медичне майно',       0.3, 7, 5),
 ('parts',   'Запчастини, ремонт',  1.2, 7, 6);

INSERT INTO depots (name, kind, region_id, lat, lon)
SELECT d.name, d.kind, r.id, d.lat, d.lon
FROM (VALUES
  ('Базовий склад «Північ» (умовний)',   'base',    'Полтавська',        49.60, 34.50),
  ('Базовий склад «Центр» (умовний)',    'base',    'Дніпропетровська',  48.50, 35.00),
  ('Базовий склад «Південь» (умовний)',  'base',    'Миколаївська',      46.95, 32.00),
  ('Базовий склад «Захід» (умовний)',    'base',    'Хмельницька',       49.42, 27.00),
  ('ППЗ-1 (умовний)',                    'forward', 'Харківська',        49.85, 36.40),
  ('ППЗ-2 (умовний)',                    'forward', 'Донецька',          48.72, 37.50),
  ('ППЗ-3 (умовний)',                    'forward', 'Запорізька',        47.85, 35.20),
  ('ППЗ-4 (умовний)',                    'forward', 'Херсонська',        46.85, 32.90),
  ('ППЗ-5 (умовний)',                    'forward', 'Сумська',           50.90, 34.80)
) AS d(name, kind, region, lat, lon)
JOIN regions r ON r.name = d.region;

DO $$
DECLARE
    u RECORD; t RECORD; dep RECORD;
    factor NUMERIC; offs INT; dist NUMERIC; speed NUMERIC; hours NUMERIC;
    dep_t TIMESTAMPTZ; plan_t TIMESTAMPTZ; arr_t TIMESTAMPTZ;
    planned NUMERIC; delivered NUMERIC; st TEXT; tr TEXT; delay_h NUMERIC;
    start_day DATE := current_date - 179;
BEGIN
    PERFORM setseed(0.23);

    FOR u IN SELECT id, lat, lon, personnel FROM units WHERE affiliation = 'F' ORDER BY id LOOP
        -- найближчий склад (дорожня відстань ≈ 1.25 × пряма)
        SELECT d.id, d.kind,
               1.25 * 111.2 * sqrt(power(d.lat - u.lat, 2) + power((d.lon - u.lon) * cos(radians(u.lat)), 2)) AS km
        INTO dep
        FROM depots d ORDER BY km LIMIT 1;
        dist := greatest(round(dep.km::numeric, 1), 8);

        FOR t IN SELECT * FROM supply_types ORDER BY ord LOOP
            factor := 0.55 + random() * 0.6;            -- забезпеченість конкретного підрозділу цим видом
            offs   := floor(random() * t.interval_days)::int;

            FOR d IN 0..179 LOOP
                CONTINUE WHEN (d + offs) % t.interval_days <> 0;

                dep_t := (start_day + d) + make_interval(hours => 4 + floor(random() * 16)::int,
                                                         mins  => floor(random() * 60)::int);
                CONTINUE WHEN dep_t > now();

                tr    := CASE WHEN dist > 250 AND random() < 0.6 THEN 'rail' ELSE 'truck' END;
                speed := CASE tr WHEN 'rail' THEN 35 ELSE 45 END;
                hours := dist / speed + CASE tr WHEN 'rail' THEN 2 ELSE 0.5 END;
                plan_t := dep_t + make_interval(secs => hours * 3600);

                planned := round((u.personnel * t.norm_kg_day * t.interval_days / 1000.0
                                  * (0.9 + random() * 0.25))::numeric, 2);
                planned := greatest(planned, 0.05);

                IF random() < (CASE dep.kind WHEN 'forward' THEN 0.025 ELSE 0.008 END) THEN
                    st := 'lost'; delivered := 0; arr_t := NULL;
                ELSE
                    delay_h := CASE WHEN random() < 0.18 THEN 2 + random() * 10 ELSE random() * 1.5 END;
                    arr_t := plan_t + make_interval(secs => delay_h * 3600);
                    delivered := round((planned * least(1, factor * (0.92 + random() * 0.16)))::numeric, 2);
                    IF arr_t > now() THEN
                        st := 'in_transit'; delivered := 0; arr_t := NULL;
                    ELSIF delay_h > 2 THEN st := 'delayed';
                    ELSE st := 'delivered';
                    END IF;
                END IF;

                INSERT INTO deliveries (depot_id, unit_id, supply_type, transport, planned_qty_t, delivered_qty_t,
                                        distance_km, depart_time, planned_arrival, arrive_time, status)
                VALUES (dep.id, u.id, t.code, tr, planned, delivered, dist, dep_t, plan_t, arr_t, st);
            END LOOP;
        END LOOP;
    END LOOP;
END $$;

-- Перевірка
SELECT status, count(*), round(sum(delivered_qty_t)) AS t FROM deliveries GROUP BY status ORDER BY 2 DESC;
