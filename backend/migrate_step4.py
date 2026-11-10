"""Bring ANY database up to date (original, step 3 or brand new). Safe to run more than once."""
import secrets

from sqlalchemy import inspect, text

from app import app, db

with app.app_context():
    db.create_all()  # creates any missing tables: clients, campaigns, deliveries, audit_logs ...

    engine = db.engine
    ts_type = "TIMESTAMP" if engine.dialect.name == "postgresql" else "DATETIME"
    existing = {c["name"] for c in inspect(engine).get_columns("clients")}
    additions = {
        "status": "VARCHAR(20) NOT NULL DEFAULT 'active'",
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

        result = conn.execute(
            text("UPDATE clients SET status = 'active' WHERE status IN ('pending', 'sent', 'failed')")
        )
        print(f"Clients switched to 'active': {result.rowcount}")

        rows = conn.execute(text("SELECT id FROM clients WHERE unsubscribe_token IS NULL")).fetchall()
        for (client_id,) in rows:
            conn.execute(text("UPDATE clients SET unsubscribe_token = :t WHERE id = :i"),
                         {"t": secrets.token_urlsafe(24), "i": client_id})
        print(f"Backfilled {len(rows)} unsubscribe tokens")

        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_clients_unsubscribe_token "
                          "ON clients (unsubscribe_token)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_clients_status ON clients (status)"))
    print("Migration complete.")