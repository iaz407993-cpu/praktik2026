-- =====================================================================
--  Аналітичний дашборд — СХЕМА БАЗИ ДАНИХ (PostgreSQL 14+)
--  Запуск:  psql -U postgres -d analytics_db -f 01_schema.sql
-- =====================================================================

DROP TABLE IF EXISTS events     CASCADE;
DROP TABLE IF EXISTS units      CASCADE;
DROP TABLE IF EXISTS unit_types CASCADE;
DROP TABLE IF EXISTS regions    CASCADE;

-- Області України (центри для карти)
CREATE TABLE regions (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(64)  NOT NULL UNIQUE,
    lat       NUMERIC(8,5) NOT NULL,
    lon       NUMERIC(8,5) NOT NULL
);

-- Типи підрозділів + Function ID за APP-6 / MIL-STD-2525C
-- (6 символів, позиції 5-10 у 15-символьному SIDC)
CREATE TABLE unit_types (
    code         VARCHAR(16) PRIMARY KEY,
    name_uk      VARCHAR(64) NOT NULL,
    function_id  VARCHAR(6)  NOT NULL
);

-- Підрозділи (умовні, синтетичні)
--   affiliation : F – свій, H – противник, N – нейтральний, U – невідомий
--   echelon     : D – взвод, E – рота, F – батальйон, H – бригада
--   sidc        : 15-символьний код умовного знака APP-6 (генерується автоматично)
CREATE TABLE units (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(128) NOT NULL,
    unit_type   VARCHAR(16)  NOT NULL REFERENCES unit_types(code),
    affiliation CHAR(1)      NOT NULL CHECK (affiliation IN ('F','H','N','U')),
    echelon     CHAR(1)      NOT NULL CHECK (echelon IN ('D','E','F','H')),
    status      CHAR(1)      NOT NULL DEFAULT 'P' CHECK (status IN ('P','A')),
    region_id   INT          NOT NULL REFERENCES regions(id),
    lat         NUMERIC(8,5) NOT NULL,
    lon         NUMERIC(8,5) NOT NULL,
    personnel   INT          NOT NULL CHECK (personnel >= 0),
    readiness   INT          NOT NULL CHECK (readiness BETWEEN 0 AND 100),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sidc        VARCHAR(15)
);

-- Автоматична генерація SIDC:  S + affiliation + G + status + FunctionID + '-' + echelon + '---'
CREATE OR REPLACE FUNCTION units_build_sidc() RETURNS trigger AS $$
BEGIN
    NEW.sidc := 'S' || NEW.affiliation || 'G' || NEW.status
             || rpad((SELECT function_id FROM unit_types WHERE code = NEW.unit_type), 6, '-')
             || '-' || NEW.echelon || '---';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_units_sidc
BEFORE INSERT OR UPDATE ON units
FOR EACH ROW EXECUTE FUNCTION units_build_sidc();

-- Події (журнал)
CREATE TABLE events (
    id          SERIAL PRIMARY KEY,
    event_time  TIMESTAMPTZ  NOT NULL,
    region_id   INT          NOT NULL REFERENCES regions(id),
    event_type  VARCHAR(32)  NOT NULL,
    severity    INT          NOT NULL CHECK (severity BETWEEN 1 AND 5),
    lat         NUMERIC(8,5) NOT NULL,
    lon         NUMERIC(8,5) NOT NULL,
    description TEXT
);

CREATE INDEX idx_units_aff     ON units(affiliation);
CREATE INDEX idx_units_region  ON units(region_id);
CREATE INDEX idx_events_time   ON events(event_time);
CREATE INDEX idx_events_region ON events(region_id);
