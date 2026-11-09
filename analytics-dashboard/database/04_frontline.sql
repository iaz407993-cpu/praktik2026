-- =====================================================================
--  ЛІНІЯ РОЗМЕЖУВАННЯ (лінія бойового зіткнення)
--  Зберігається версіями: на карті показується версія, чинна на кінцеву дату вибірки.
--  УВАГА: координати ОРІЄНТОВНІ й спрощені — лише для навчання/демонстрації.
--  Для реальної роботи завантажте актуальну лінію з офіційного джерела
--  (новий рядок у frontline_versions + точки у frontline_points).
-- =====================================================================

DROP TABLE IF EXISTS frontline_points   CASCADE;
DROP TABLE IF EXISTS frontline_versions CASCADE;

CREATE TABLE frontline_versions (
    id          SERIAL PRIMARY KEY,
    valid_from  DATE         NOT NULL UNIQUE,   -- з якої дати чинна ця лінія
    name        VARCHAR(128) NOT NULL,
    source      VARCHAR(256)
);

CREATE TABLE frontline_points (
    version_id  INT          NOT NULL REFERENCES frontline_versions(id) ON DELETE CASCADE,
    seq         INT          NOT NULL,          -- порядок точок уздовж лінії (з півночі на південь)
    lat         NUMERIC(8,5) NOT NULL,
    lon         NUMERIC(8,5) NOT NULL,
    PRIMARY KEY (version_id, seq)
);

INSERT INTO frontline_versions (valid_from, name, source)
VALUES (DATE '2026-01-01', 'Лінія розмежування (орієнтовна)', 'Спрощена навчальна схема, не для оперативного використання');

INSERT INTO frontline_points (version_id, seq, lat, lon)
SELECT v.id, p.seq, p.lat, p.lon
FROM frontline_versions v
CROSS JOIN (VALUES
  ( 1, 50.360, 36.930),   -- державний кордон, Харківщина
  ( 2, 50.290, 36.940),
  ( 3, 50.050, 37.350),
  ( 4, 49.720, 37.620),
  ( 5, 49.450, 37.850),
  ( 6, 49.150, 37.950),
  ( 7, 49.000, 38.050),
  ( 8, 48.860, 38.100),
  ( 9, 48.650, 37.950),
  (10, 48.590, 37.850),
  (11, 48.400, 37.800),
  (12, 48.330, 37.450),
  (13, 48.270, 37.200),
  (14, 48.050, 37.100),
  (15, 47.900, 36.850),
  (16, 47.700, 36.450),
  (17, 47.600, 36.200),
  (18, 47.450, 35.850),
  (19, 47.500, 35.450),
  (20, 47.500, 35.250),
  (21, 47.400, 34.900),   -- далі — по Дніпру
  (22, 47.200, 34.400),
  (23, 46.950, 33.900),
  (24, 46.780, 33.400),
  (25, 46.670, 33.000),
  (26, 46.600, 32.650),
  (27, 46.520, 32.250),
  (28, 46.500, 31.950),
  (29, 46.530, 31.550)
) AS p(seq, lat, lon)
WHERE v.valid_from = DATE '2026-01-01';
