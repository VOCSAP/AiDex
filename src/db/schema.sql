-- ============================================================
-- AiDex SQLite Schema
-- Version: 1.4
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ------------------------------------------------------------
-- Dateibaum
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    last_indexed INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);

-- ------------------------------------------------------------
-- Zeilenobjekte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lines (
    id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    line_number INTEGER NOT NULL,
    line_type TEXT NOT NULL CHECK(line_type IN ('code', 'comment', 'struct', 'method', 'property', 'string')),
    line_hash TEXT,
    modified INTEGER,
    PRIMARY KEY (file_id, id),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lines_file ON lines(file_id);
CREATE INDEX IF NOT EXISTS idx_lines_type ON lines(line_type);

-- ------------------------------------------------------------
-- Items (Terme)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE INDEX IF NOT EXISTS idx_items_term ON items(term);

-- ------------------------------------------------------------
-- Item-Vorkommen
-- ------------------------------------------------------------
-- `kind` says WHY this occurrence exists: the term was seen as a code symbol,
-- as an indexed string literal, or as both on the same line.
--
-- It is not part of the primary key on purpose. Adding it there would force a
-- table rebuild on every existing index, and the case it would serve is rare:
-- measured on koryphaios, 158 of 10 376 literal occurrences (1.5%) land on a
-- line where the same term is already a symbol. Those collapse to 'both', which
-- keeps one row and loses nothing -- a filter on either kind still matches it.
CREATE TABLE IF NOT EXISTS occurrences (
    item_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    line_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'symbol' CHECK(kind IN ('symbol', 'literal', 'both')),
    PRIMARY KEY (item_id, file_id, line_id),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id, line_id) REFERENCES lines(file_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_occurrences_item ON occurrences(item_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_file ON occurrences(file_id);

-- ------------------------------------------------------------
-- Datei-Signaturen
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signatures (
    file_id INTEGER PRIMARY KEY,
    header_comments TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- Methoden/Funktionen
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    prototype TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    visibility TEXT,
    is_static INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    body_text TEXT,
    body_lines INTEGER,
    body_truncated INTEGER DEFAULT 0,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_methods_file ON methods(file_id);
CREATE INDEX IF NOT EXISTS idx_methods_name ON methods(name);
CREATE INDEX IF NOT EXISTS idx_methods_name_nocase ON methods(name COLLATE NOCASE);

-- ------------------------------------------------------------
-- Klassen/Structs/Interfaces
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('class', 'struct', 'interface', 'enum', 'type')),
    line_number INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_types_file ON types(file_id);
CREATE INDEX IF NOT EXISTS idx_types_name ON types(name);


-- ------------------------------------------------------------
-- Syntax-derived candidate relationships
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidate_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL,
    target_file_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('import', 'call')),
    confidence TEXT NOT NULL DEFAULT 'candidate' CHECK(confidence = 'candidate'),
    source_symbol TEXT NOT NULL DEFAULT '',
    target_symbol TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    target_line INTEGER,
    provenance TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (target_file_id) REFERENCES files(id) ON DELETE SET NULL,
    UNIQUE (source_file_id, kind, source_line, source_symbol, target_symbol, provenance)
);

CREATE INDEX IF NOT EXISTS idx_candidate_edges_source ON candidate_edges(source_file_id);
CREATE INDEX IF NOT EXISTS idx_candidate_edges_target ON candidate_edges(target_file_id);
CREATE INDEX IF NOT EXISTS idx_candidate_edges_symbol ON candidate_edges(target_symbol);
CREATE INDEX IF NOT EXISTS idx_candidate_edges_kind ON candidate_edges(kind);
-- ------------------------------------------------------------
-- Abhängigkeiten zu anderen AiDex-Instanzen
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT,
    last_checked INTEGER
);

-- ------------------------------------------------------------
-- Projektstruktur (alle Dateien + Verzeichnisse)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('dir', 'code', 'config', 'doc', 'asset', 'test', 'other')),
    extension TEXT,
    indexed INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(path);
CREATE INDEX IF NOT EXISTS idx_project_files_type ON project_files(type);

-- ------------------------------------------------------------
-- Task Backlog
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
    status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'active', 'done', 'cancelled')),
    tags TEXT,
    source TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    due INTEGER,
    interval TEXT,
    action TEXT,
    auto_go INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);

-- ------------------------------------------------------------
-- Task Log (History/Notizen pro Task)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id);

-- ------------------------------------------------------------
-- Note History (archiviert überschriebene Session-Notizen)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_history_created ON note_history(created_at);

-- ------------------------------------------------------------
-- Metadaten
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);
