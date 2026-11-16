"""Camada de dados: o SQLite onde o nó guarda a blockchain e os participantes.

Tabelas:
- blocks:       a blockchain. Só aceita inserção: os gatilhos bloqueiam UPDATE e DELETE.
- participants: quem pode enviar transações, com o hash do token (nunca o token em si).
- settings:     configurações da corrente, como a dificuldade usada na mineração.

As cotas e os donos dos peixes NÃO ficam no banco: eles são recalculados a partir dos blocos.
"""

import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager

from pirarucu.blockchain import Block

SCHEMA = """
CREATE TABLE IF NOT EXISTS blocks (
    idx           INTEGER PRIMARY KEY,
    timestamp     INTEGER NOT NULL,
    previous_hash TEXT,
    data          TEXT    NOT NULL,  -- transação em JSON
    nonce         INTEGER NOT NULL,
    hash          TEXT    NOT NULL UNIQUE
);

-- A blockchain só cresce: nenhum bloco pode ser alterado ou apagado
CREATE TRIGGER IF NOT EXISTS blocks_no_update BEFORE UPDATE ON blocks
BEGIN
    SELECT RAISE(ABORT, 'blocks are append-only');
END;

CREATE TRIGGER IF NOT EXISTS blocks_no_delete BEFORE DELETE ON blocks
BEGIN
    SELECT RAISE(ABORT, 'blocks are append-only');
END;

CREATE TABLE IF NOT EXISTS participants (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path):
        self.path = path
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def _connect(self):
        # Uma conexão por operação (o FastAPI usa várias threads)
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # Blocos

    def add_block(self, block):
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO blocks (idx, timestamp, previous_hash, data, nonce, hash) VALUES (?, ?, ?, ?, ?, ?)",
                (block.index, block.timestamp, block.previous_hash,
                 json.dumps(block.data, ensure_ascii=False), block.nonce, block.hash))

    def list_blocks(self):
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM blocks ORDER BY idx").fetchall()
        return [Block(row["idx"], row["timestamp"], row["previous_hash"], json.loads(row["data"]),
                      nonce=row["nonce"], block_hash=row["hash"])
                for row in rows]

    # Participantes

    def seed_participants(self, participants):
        """Cadastra os participantes que ainda não existem (usado na primeira execução)."""
        with self._connect() as conn:
            for p in participants:
                conn.execute(
                    "INSERT OR IGNORE INTO participants (id, name, role, token_hash) VALUES (?, ?, ?, ?)",
                    (p["id"], p["name"], p["role"], hash_token(p["token"])))

    def list_participants(self):
        with self._connect() as conn:
            rows = conn.execute("SELECT id, name, role FROM participants ORDER BY id").fetchall()
        return [dict(row) for row in rows]

    def find_participant_by_token(self, token):
        with self._connect() as conn:
            row = conn.execute("SELECT id, name, role FROM participants WHERE token_hash = ?",
                               (hash_token(token),)).fetchone()
        return dict(row) if row else None

    # Configurações

    def get_setting(self, key):
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key, value):
        with self._connect() as conn:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))


def hash_token(token):
    # O banco guarda só o hash do token
    return hashlib.sha256(token.encode()).hexdigest()
