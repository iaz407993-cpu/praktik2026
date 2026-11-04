-- Панорама-ОВУ: схема БД (одна таблиця подій)
DROP TABLE IF EXISTS incidents;

CREATE TABLE incidents (
    id          SERIAL PRIMARY KEY,
    occurred_at TIMESTAMP NOT NULL,
    sector      TEXT      NOT NULL,
    direction   TEXT      NOT NULL,
    event_type  TEXT      NOT NULL,
    intensity   INT       NOT NULL CHECK (intensity BETWEEN 1 AND 50),
    source      TEXT,              -- чутливе поле: приховується в режимі demo/public
    summary     TEXT
);

CREATE INDEX idx_incidents_occurred_at ON incidents (occurred_at);
CREATE INDEX idx_incidents_sector      ON incidents (sector);
CREATE INDEX idx_incidents_direction   ON incidents (direction);
CREATE INDEX idx_incidents_event_type  ON incidents (event_type);
