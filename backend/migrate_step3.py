"""One-time migration for databases created before step 3. Safe to run more than once."""
import secrets

from sqlalchemy import inspect, text

from app import app, db

with app.app_context():
    engine = db.engine
    is_pg = engine.dialect.name == "postgresql"
    ts_type = "TIMESTAMP" if is_pg else "DATETIME"

    existing = {c["name"] for c in inspect(engine).get_columns("clients")}
    additions = {
        "status": "VARCHAR(20) NOT NULL DEFAULT 'pending'",
        "attempts": "INTEGER NOT NULL DEFAULT 0",
        "last_error": "VARCHAR(500)",
        "sent_at": ts_type,
        "unsubscribe_token": "VARCHAR(64)",
    }
    with engine.begin() as conn:
        for name, ddl in additions.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE clients ADD COLUMN {name} {ddl}"))
                print(f"Added column: {name}")

        conn.execute(text("UPDATE clients SET status = 'sent' WHERE is_sent = :t AND status = 'pending'"),
                     {"t": True})

        rows = conn.execute(text("SELECT id FROM clients WHERE unsubscribe_token IS NULL")).fetchall()
        for (client_id,) in rows:
            conn.execute(text("UPDATE clients SET unsubscribe_token = :t WHERE id = :i"),
                         {"t": secrets.token_urlsafe(24), "i": client_id})
        print(f"Backfilled {len(rows)} unsubscribe tokens")

        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_clients_unsubscribe_token "
                          "ON clients (unsubscribe_token)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_clients_status ON clients (status)"))
    print("Migration complete.")