-- =====================================================================
--  СИНТЕТИЧНІ ДАНІ (вигадані, для навчання / демонстрації)
--  Запуск:  psql -U postgres -d analytics_db -f 02_seed.sql
--  Повторний запуск перезаписує дані (детерміновано, setseed).
-- =====================================================================

TRUNCATE events, units, unit_types, regions RESTART IDENTITY CASCADE;

INSERT INTO regions (name, lat, lon) VALUES
 ('Вінницька',          49.233, 28.468),
 ('Волинська',          50.747, 25.325),
 ('Дніпропетровська',   48.464, 35.046),
 ('Донецька',           48.000, 37.800),
 ('Житомирська',        50.254, 28.658),
 ('Закарпатська',       48.620, 22.700),
 ('Запорізька',         47.600, 35.400),
 ('Івано-Франківська',  48.922, 24.711),
 ('Київська',           50.050, 30.300),
 ('м. Київ',            50.450, 30.523),
 ('Кіровоградська',     48.507, 32.262),
 ('Луганська',          48.900, 39.300),
 ('Львівська',          49.839, 24.029),
 ('Миколаївська',       47.150, 31.900),
 ('Одеська',            46.900, 30.200),
 ('Полтавська',         49.588, 34.551),
 ('Рівненська',         50.619, 26.251),
 ('Сумська',            50.907, 34.798),
 ('Тернопільська',      49.553, 25.594),
 ('Харківська',         49.700, 36.400),
 ('Херсонська',         46.750, 33.300),
 ('Хмельницька',        49.422, 26.987),
 ('Черкаська',          49.444, 32.059),
 ('Чернівецька',        48.292, 25.935),
 ('Чернігівська',       51.498, 31.289),
 ('АР Крим',            45.300, 34.300);

INSERT INTO unit_types (code, name_uk, function_id) VALUES
 ('mech_inf',  'Механізований',      'UCIZ'),
 ('infantry',  'Піхотний',           'UCI'),
 ('armor',     'Танковий',           'UCA'),
 ('artillery', 'Артилерійський',     'UCF'),
 ('air_def',   'ППО',                'UCD'),
 ('recon',     'Розвідувальний',     'UCR'),
 ('uav',       'БпЛА',               'UCVU'),
 ('engineer',  'Інженерний',         'UCE'),
 ('signal',    'Зв''язку',           'UUS'),
 ('medical',   'Медичний',           'USM');

DO $$
DECLARE
    all_regions  INT[]  := ARRAY(SELECT id FROM regions);
    east_regions INT[]  := ARRAY(SELECT id FROM regions
                                 WHERE name IN ('Донецька','Луганська','Запорізька',
                                                'Херсонська','Харківська','АР Крим'));
    types        TEXT[] := ARRAY(SELECT code FROM unit_types);
    echelons     CHAR[] := ARRAY['D','E','F','H'];
    ech_name     TEXT[] := ARRAY['взвод','рота','батальйон','бригада'];
    ech_people   INT[]  := ARRAY[30, 120, 500, 2500];
    ev_types     TEXT[] := ARRAY['Обстріл','Розвідка БпЛА','Логістика',
                                 'Ротація','Ураження цілі','Інженерні роботи'];
    r INT; t TEXT; e INT; aff CHAR; rlat NUMERIC; rlon NUMERIC; tname TEXT;
BEGIN
    PERFORM setseed(0.42);

    -- 70 підрозділів: 45 своїх, 25 противника
    FOR i IN 1..70 LOOP
        IF i <= 45 THEN
            aff := 'F';
            r := all_regions[1 + floor(random() * array_length(all_regions, 1))::int];
        ELSE
            aff := 'H';
            r := east_regions[1 + floor(random() * array_length(east_regions, 1))::int];
        END IF;
        t := types[1 + floor(random() * array_length(types, 1))::int];
        e := 1 + floor(random() * 4)::int;
        SELECT lat, lon INTO rlat, rlon FROM regions WHERE id = r;
        SELECT name_uk INTO tname FROM unit_types WHERE code = t;

        INSERT INTO units (name, unit_type, affiliation, echelon, status, region_id,
                           lat, lon, personnel, readiness, updated_at)
        VALUES (
            format('%s %s %s-%s', tname, ech_name[e],
                   CASE aff WHEN 'F' THEN 'Умовний' ELSE 'Ціль' END, i),
            t, aff, echelons[e],
            CASE WHEN random() < 0.12 THEN 'A' ELSE 'P' END,
            r,
            round((rlat + (random() - 0.5) * 0.5)::numeric, 5),
            round((rlon + (random() - 0.5) * 0.7)::numeric, 5),
            round(ech_people[e] * (0.6 + random() * 0.5)),
            CASE aff WHEN 'F' THEN 45 + floor(random() * 56)::int
                     ELSE 20 + floor(random() * 71)::int END,
            now() - (random() * interval '72 hours')
        );
    END LOOP;

    -- 600 подій за останні 90 днів (більше — на сході)
    FOR i IN 1..600 LOOP
        IF random() < 0.65 THEN
            r := east_regions[1 + floor(random() * array_length(east_regions, 1))::int];
        ELSE
            r := all_regions[1 + floor(random() * array_length(all_regions, 1))::int];
        END IF;
        SELECT lat, lon INTO rlat, rlon FROM regions WHERE id = r;
        t := ev_types[1 + floor(random() * array_length(ev_types, 1))::int];

        INSERT INTO events (event_time, region_id, event_type, severity, lat, lon, description)
        VALUES (
            now() - (power(random(), 1.3) * interval '90 days'),
            r, t,
            1 + floor(random() * 5)::int,
            round((rlat + (random() - 0.5) * 0.6)::numeric, 5),
            round((rlon + (random() - 0.5) * 0.8)::numeric, 5),
            format('%s — синтетичний запис №%s', t, i)
        );
    END LOOP;
END $$;

-- Перевірка
SELECT 'regions' AS tbl, count(*) FROM regions
UNION ALL SELECT 'unit_types', count(*) FROM unit_types
UNION ALL SELECT 'units',      count(*) FROM units
UNION ALL SELECT 'events',     count(*) FROM events;
