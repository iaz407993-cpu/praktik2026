-- =====================================================================
--  ВОГНЕВЕ УРАЖЕННЯ ТА ВТРАТИ ПРОТИВНИКА — схема + синтетичні дані
--  Запуск (після 01 і 02):  psql -U postgres -d analytics_db -f 03_strikes.sql
--  Усі дані вигадані. Повторний запуск перезаписує дані (детерміновано).
-- =====================================================================

DROP TABLE IF EXISTS enemy_losses    CASCADE;
DROP TABLE IF EXISTS fire_strikes    CASCADE;
DROP TABLE IF EXISTS loss_categories CASCADE;
DROP TABLE IF EXISTS strike_types    CASCADE;

-- Види вогневого ураження
CREATE TABLE strike_types (
    code     VARCHAR(16) PRIMARY KEY,
    name_uk  VARCHAR(64) NOT NULL,
    ord      INT         NOT NULL
);

-- Категорії втрат противника
--   grp: personnel — особовий склад, equipment — техніка / об'єкти
CREATE TABLE loss_categories (
    code     VARCHAR(16) PRIMARY KEY,
    name_uk  VARCHAR(64) NOT NULL,
    grp      VARCHAR(16) NOT NULL CHECK (grp IN ('personnel','equipment')),
    ord      INT         NOT NULL
);

-- Журнал вогневих уражень
CREATE TABLE fire_strikes (
    id           SERIAL PRIMARY KEY,
    strike_time  TIMESTAMPTZ  NOT NULL,
    region_id    INT          NOT NULL REFERENCES regions(id),
    strike_type  VARCHAR(16)  NOT NULL REFERENCES strike_types(code),
    lat          NUMERIC(8,5) NOT NULL,
    lon          NUMERIC(8,5) NOT NULL,
    target       VARCHAR(128) NOT NULL,
    success      BOOLEAN      NOT NULL,
    description  TEXT
);

-- Втрати противника, підтверджені за результатами ураження
CREATE TABLE enemy_losses (
    id         SERIAL PRIMARY KEY,
    strike_id  INT         NOT NULL REFERENCES fire_strikes(id) ON DELETE CASCADE,
    category   VARCHAR(16) NOT NULL REFERENCES loss_categories(code),
    qty        INT         NOT NULL CHECK (qty > 0),
    UNIQUE (strike_id, category)
);

CREATE INDEX idx_strikes_time   ON fire_strikes(strike_time);
CREATE INDEX idx_strikes_type   ON fire_strikes(strike_type);
CREATE INDEX idx_strikes_region ON fire_strikes(region_id);
CREATE INDEX idx_losses_strike  ON enemy_losses(strike_id);

INSERT INTO strike_types (code, name_uk, ord) VALUES
 ('fpv',        'FPV-дрони',               1),
 ('drop_uav',   'Скиди з БпЛА',            2),
 ('artillery',  'Ствольна артилерія',      3),
 ('mortar',     'Міномети',                4),
 ('mlrs',       'РСЗВ',                    5),
 ('strike_uav', 'Ударні БпЛА (далекі)',    6),
 ('atgm',       'ПТРК',                    7),
 ('tank_fire',  'Вогонь танків',           8),
 ('aviation',   'Авіація (КАБ, НАР)',      9),
 ('missile',    'Ракетні удари',          10);

INSERT INTO loss_categories (code, name_uk, grp, ord) VALUES
 ('kia',       'Ліквідовано о/с',        'personnel', 1),
 ('wia',       'Поранено о/с',           'personnel', 2),
 ('tank',      'Танки',                  'equipment', 3),
 ('afv',       'ББМ',                    'equipment', 4),
 ('artillery', 'Артсистеми',             'equipment', 5),
 ('mlrs',      'РСЗВ',                   'equipment', 6),
 ('air_def',   'Засоби ППО',             'equipment', 7),
 ('vehicle',   'Автотехніка',            'equipment', 8),
 ('ammo',      'Склади БК / ПММ',        'equipment', 9),
 ('command',   'Пункти управління',      'equipment', 10);

DO $$
DECLARE
    -- область фронту повторюється пропорційно інтенсивності
    front INT[] := ARRAY(
        SELECT r.id FROM regions r
        JOIN (VALUES ('Донецька',6),('Запорізька',3),('Харківська',3),('Луганська',2),
                     ('Херсонська',2),('Сумська',1),('Дніпропетровська',1)) w(n,k) ON w.n = r.name
        CROSS JOIN LATERAL generate_series(1, w.k));
    -- види ураження з вагами (відсотки)
    st_codes  TEXT[] := ARRAY['fpv','drop_uav','artillery','mortar','mlrs','strike_uav','atgm','tank_fire','aviation','missile'];
    st_weight INT[]  := ARRAY[ 28,   14,        20,         10,      7,     7,           5,     4,          3,         2 ];
    target_name JSONB := '{"kia":"Особовий склад","tank":"Танк","afv":"ББМ","artillery":"Артсистема",
                           "mlrs":"РСЗВ","air_def":"Засіб ППО","vehicle":"Автотехніка",
                           "ammo":"Склад БК / ПММ","command":"Пункт управління"}';
    r INT; t TEXT; roll INT; acc INT; ok BOOLEAN;
    p_pers NUMERIC; max_k INT; p_eq NUMERIC; eq TEXT[];
    eq_cat TEXT; tgt TEXT; sid INT; kia INT; rlat NUMERIC; rlon NUMERIC;
BEGIN
    PERFORM setseed(0.17);

    FOR i IN 1..2400 LOOP
        -- вид ураження за вагами
        roll := floor(random() * 100)::int; acc := 0;
        FOR k IN 1..array_length(st_codes, 1) LOOP
            acc := acc + st_weight[k];
            IF roll < acc THEN t := st_codes[k]; EXIT; END IF;
        END LOOP;

        -- профіль втрат для виду ураження
        CASE t
          WHEN 'fpv'        THEN p_pers := .55; max_k := 2;  p_eq := .55; eq := '{vehicle,vehicle,afv,tank,artillery,ammo}';
          WHEN 'drop_uav'   THEN p_pers := .70; max_k := 2;  p_eq := .30; eq := '{vehicle,afv,ammo}';
          WHEN 'artillery'  THEN p_pers := .60; max_k := 4;  p_eq := .35; eq := '{artillery,vehicle,afv,ammo,mlrs}';
          WHEN 'mortar'     THEN p_pers := .75; max_k := 3;  p_eq := .10; eq := '{vehicle}';
          WHEN 'mlrs'       THEN p_pers := .60; max_k := 6;  p_eq := .30; eq := '{vehicle,ammo,afv}';
          WHEN 'strike_uav' THEN p_pers := .30; max_k := 3;  p_eq := .80; eq := '{ammo,air_def,artillery,mlrs,command,vehicle}';
          WHEN 'atgm'       THEN p_pers := .30; max_k := 2;  p_eq := .85; eq := '{tank,afv,afv,vehicle}';
          WHEN 'tank_fire'  THEN p_pers := .60; max_k := 3;  p_eq := .40; eq := '{afv,vehicle,tank}';
          WHEN 'aviation'   THEN p_pers := .70; max_k := 10; p_eq := .50; eq := '{ammo,command,vehicle,afv}';
          ELSE                   p_pers := .60; max_k := 15; p_eq := .80; eq := '{air_def,command,ammo,mlrs,artillery}';
        END CASE;

        r  := front[1 + floor(random() * array_length(front, 1))::int];
        SELECT lat, lon INTO rlat, rlon FROM regions WHERE id = r;
        ok := random() < 0.78;
        eq_cat := eq[1 + floor(random() * array_length(eq, 1))::int];
        tgt := CASE WHEN random() < p_eq THEN target_name ->> eq_cat ELSE 'Особовий склад' END;

        INSERT INTO fire_strikes (strike_time, region_id, strike_type, lat, lon, target, success, description)
        VALUES (
            now() - (power(random(), 1.15) * interval '180 days'),
            r, t,
            round((rlat + (random() - 0.5) * 0.6)::numeric, 5),
            round((rlon + (random() - 0.5) * 0.9)::numeric, 5),
            tgt, ok,
            format('Ціль: %s — %s (синтетичний запис №%s)', tgt,
                   CASE WHEN ok THEN 'уражено' ELSE 'без підтвердженого результату' END, i)
        ) RETURNING id INTO sid;

        IF ok THEN
            IF tgt = 'Особовий склад' OR random() < p_pers THEN
                kia := 1 + floor(random() * max_k)::int;
                INSERT INTO enemy_losses (strike_id, category, qty) VALUES (sid, 'kia', kia);
                IF random() < 0.7 THEN
                    INSERT INTO enemy_losses (strike_id, category, qty)
                    VALUES (sid, 'wia', 1 + floor(random() * max_k * 1.5)::int);
                END IF;
            END IF;
            IF tgt <> 'Особовий склад' THEN
                INSERT INTO enemy_losses (strike_id, category, qty)
                VALUES (sid, eq_cat, CASE WHEN t IN ('missile','aviation','mlrs') AND random() < 0.3 THEN 2 ELSE 1 END)
                ON CONFLICT (strike_id, category) DO UPDATE SET qty = enemy_losses.qty + EXCLUDED.qty;
            END IF;
        END IF;
    END LOOP;
END $$;

-- Перевірка
SELECT 'fire_strikes' AS tbl, count(*) FROM fire_strikes
UNION ALL SELECT 'enemy_losses', count(*) FROM enemy_losses;
