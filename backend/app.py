import csv
import hmac
import html
import io
import logging
import os
import secrets
import time
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from email_validator import EmailNotValidError, validate_email
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    get_jwt,
    jwt_required,
    verify_jwt_in_request,
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_sqlalchemy import SQLAlchemy
from passlib.context import CryptContext

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("mailing")


def require_env(name: str, min_length: int = 1) -> str:
    """Return an environment variable or stop the app from starting."""
    value = os.getenv(name, "")
    if len(value) < min_length:
        raise RuntimeError(
            f"Environment variable {name} is missing or too short "
            f"(need at least {min_length} characters). See .env.example."
        )
    return value


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


app = Flask(__name__)

app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", "sqlite:///secureai_mailing.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["JWT_SECRET_KEY"] = require_env("JWT_SECRET_KEY", min_length=32)

if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite"):
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"connect_args": {"check_same_thread": False}}

db = SQLAlchemy(app)
jwt = JWTManager(app)
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:3000", "http://127.0.0.1:3000"]}})
limiter = Limiter(get_remote_address, app=app, default_limits=[], storage_uri="memory://")

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

BREVO_API_KEY = os.getenv("BREVO_API_KEY")
CRON_SECRET = require_env("CRON_SECRET", min_length=16)
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "newsletter@secureailabs.com")
SENDER_NAME = os.getenv("SENDER_NAME", "SecureAI Labs")
EMAIL_SUBJECT = os.getenv("EMAIL_SUBJECT", "SecureAI Labs Platform Update")
PUBLIC_API_URL = os.getenv("PUBLIC_API_URL", "http://localhost:8000").rstrip("/")

MAX_BATCH_SIZE = int(os.getenv("MAX_BATCH_SIZE", "300"))          # Brevo free tier: 300/day
BATCH_TIME_LIMIT = int(os.getenv("BATCH_TIME_LIMIT_SECONDS", "45"))  # stop before the worker times out
MAX_ATTEMPTS = int(os.getenv("MAX_SEND_ATTEMPTS", "3"))           # batch runs before a client is "failed"
HTTP_RETRIES = 3                                                  # tries per request for transient errors


# --- Models ---
class Admin(db.Model):
    __tablename__ = "admins"
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)


class Client(db.Model):
    __tablename__ = "clients"
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    name = db.Column(db.String(255), nullable=True)
    is_sent = db.Column(db.Boolean, default=False, index=True)  # kept for backward compatibility
    # pending | sent | failed | unsubscribed
    status = db.Column(db.String(20), nullable=False, default="pending", index=True)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    last_error = db.Column(db.String(500), nullable=True)
    sent_at = db.Column(db.DateTime, nullable=True)
    unsubscribe_token = db.Column(
        db.String(64), unique=True, index=True, default=lambda: secrets.token_urlsafe(24)
    )


# --- Email content ---
def render_email_html(name, unsubscribe_url):
    greeting = html.escape(name) if name else "there"
    return f"""<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:8px;padding:32px;">
          <tr><td>
            <h2 style="margin:0 0 16px;">SecureAI Labs</h2>
            <p>Hello {greeting},</p>
            <p>Thank you for being part of the SecureAI Labs community. We have an update on our platform to share with you.</p>
            <p>Best regards,<br>The SecureAI Labs Team</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
            <p style="font-size:12px;color:#6b7280;">
              You are receiving this email because you are a SecureAI Labs contact.
              <a href="{unsubscribe_url}">Unsubscribe</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>"""


def render_email_text(name, unsubscribe_url):
    return (
        f"Hello {name or 'there'},\n\n"
        "Thank you for being part of the SecureAI Labs community. "
        "We have an update on our platform to share with you.\n\n"
        "Best regards,\nThe SecureAI Labs Team\n\n"
        f"Unsubscribe: {unsubscribe_url}\n"
    )


# --- Sending ---
class BrevoAuthError(Exception):
    """Brevo rejected our API key. Retrying other clients is pointless."""


def send_email(client):
    """Send one email. Returns (ok, error_message, permanent_failure)."""
    unsubscribe_url = f"{PUBLIC_API_URL}/api/unsubscribe/{client.unsubscribe_token}"
    payload = {
        "sender": {"name": SENDER_NAME, "email": SENDER_EMAIL},
        "to": [{"email": client.email, "name": client.name or "Subscriber"}],
        "subject": EMAIL_SUBJECT,
        "htmlContent": render_email_html(client.name, unsubscribe_url),
        "textContent": render_email_text(client.name, unsubscribe_url),
        "headers": {
            "List-Unsubscribe": f"<{unsubscribe_url}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    }
    headers = {"accept": "application/json", "api-key": BREVO_API_KEY, "content-type": "application/json"}

    error = "unknown error"
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            response = requests.post(
                "https://api.brevo.com/v3/smtp/email", headers=headers, json=payload, timeout=10
            )
        except requests.RequestException as exc:
            error = f"network error: {type(exc).__name__}"
        else:
            if response.status_code in (200, 201):
                return True, None, False
            if response.status_code in (401, 403):
                raise BrevoAuthError(f"Brevo returned {response.status_code}")
            error = f"Brevo {response.status_code}: {response.text[:200]}"
            # 4xx (except timeout / rate limit) will never succeed on retry
            if 400 <= response.status_code < 500 and response.status_code not in (408, 429):
                return False, error, True
        if attempt < HTTP_RETRIES:
            time.sleep(2 ** (attempt - 1))  # 1s, 2s
    return False, error, False


def send_batch_impl():
    if not BREVO_API_KEY:
        return jsonify({"detail": "BREVO_API_KEY is not configured on the server"}), 500

    clients = (
        Client.query.filter_by(status="pending").order_by(Client.id).limit(MAX_BATCH_SIZE).all()
    )
    if not clients:
        return jsonify({"message": "All emails have been sent!", "sent_count": 0, "failed_count": 0,
                        "remaining": 0})

    deadline = time.monotonic() + BATCH_TIME_LIMIT
    sent_count = failed_count = 0
    stopped_reason = None

    for client in clients:
        if time.monotonic() > deadline:
            stopped_reason = "time limit reached; run the batch again to continue"
            break
        try:
            ok, error, permanent = send_email(client)
        except BrevoAuthError as exc:
            log.error("Batch aborted: %s (check BREVO_API_KEY)", exc)
            stopped_reason = "Brevo rejected the API key"
            break

        client.attempts += 1
        if ok:
            client.status = "sent"
            client.is_sent = True
            client.sent_at = utcnow()
            client.last_error = None
            sent_count += 1
        else:
            client.last_error = (error or "")[:500]
            if permanent or client.attempts >= MAX_ATTEMPTS:
                client.status = "failed"
                failed_count += 1
            log.warning("Send failed for client %s (attempt %s): %s", client.id, client.attempts, error)
        db.session.commit()

    remaining = Client.query.filter_by(status="pending").count()
    log.info("Batch finished: sent=%s failed=%s remaining=%s", sent_count, failed_count, remaining)
    body = {"success": stopped_reason is None, "sent_count": sent_count,
            "failed_count": failed_count, "remaining": remaining}
    if stopped_reason:
        body["stopped_reason"] = stopped_reason
    return jsonify(body), (502 if stopped_reason == "Brevo rejected the API key" else 200)


# --- Auth helper ---
def is_cron_request() -> bool:
    """True if the Authorization header carries the cron secret (constant-time compare)."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return False
    token = header[len("Bearer "):]
    return hmac.compare_digest(token.encode(), CRON_SECRET.encode())


# --- Endpoints ---
@app.post("/api/login")
@limiter.limit("5 per minute")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    password = data.get("password")

    if not isinstance(email, str) or not isinstance(password, str):
        return jsonify({"detail": "Email and password are required"}), 400

    admin = Admin.query.filter_by(email=email).first()
    if not admin or not pwd_context.verify(password, admin.password_hash):
        return jsonify({"detail": "Incorrect email or password"}), 401

    access_token = create_access_token(identity=admin.email)
    return jsonify({"access_token": access_token, "token_type": "bearer"})


@app.get("/api/status")
@jwt_required()
def get_status():
    counts = {s: Client.query.filter_by(status=s).count()
              for s in ("pending", "sent", "failed", "unsubscribed")}
    return jsonify({
        "total": Client.query.count(),
        "sent": counts["sent"],
        "remaining": counts["pending"],
        "failed": counts["failed"],
        "unsubscribed": counts["unsubscribed"],
    })


@app.post("/api/send-batch")
@limiter.limit("10 per hour")
def send_batch():
    if is_cron_request():
        return send_batch_impl()
    try:
        verify_jwt_in_request()
    except Exception:
        return jsonify({"detail": "Invalid or missing credentials"}), 401
    if get_jwt().get("type") != "access":
        return jsonify({"detail": "Access token required"}), 401
    return send_batch_impl()


@app.get("/api/failures")
@jwt_required()
def list_failures():
    rows = Client.query.filter_by(status="failed").order_by(Client.id).limit(200).all()
    return jsonify([
        {"id": c.id, "email": c.email, "attempts": c.attempts, "last_error": c.last_error}
        for c in rows
    ])


@app.post("/api/retry-failed")
@jwt_required()
def retry_failed():
    rows = Client.query.filter_by(status="failed").all()
    for c in rows:
        c.status = "pending"
        c.attempts = 0
        c.last_error = None
    db.session.commit()
    return jsonify({"success": True, "requeued": len(rows)})


@app.get("/api/check-email")
@jwt_required()
def check_email():
    email = request.args.get("email")
    if not email:
        return jsonify({"error": "Email parameter is required"}), 400

    client = Client.query.filter_by(email=email).first()
    if client:
        return jsonify({
            "exists": True,
            "id": client.id,
            "email": client.email,
            "is_sent": client.is_sent,
            "status": client.status,
        }), 200
    return jsonify({"exists": False}), 200


@app.post("/api/import-clients")
@jwt_required()
def import_clients():
    if "file" not in request.files:
        return jsonify({"detail": "No file uploaded"}), 400

    stream = io.TextIOWrapper(request.files["file"].stream, encoding="utf-8-sig")
    reader = csv.DictReader(stream)

    added_count = 0
    skipped_invalid = 0
    for row in reader:
        raw_email = (row.get("email") or "").strip()
        name = (row.get("name") or "").strip() or None
        try:
            email = validate_email(raw_email, check_deliverability=False).normalized
        except EmailNotValidError:
            skipped_invalid += 1
            continue

        if not Client.query.filter_by(email=email).first():
            db.session.add(Client(email=email, name=name))
            added_count += 1

    db.session.commit()
    return jsonify({"success": True, "added_count": added_count, "skipped_invalid": skipped_invalid})


# --- Public unsubscribe (no login: the secret token in the link is the credential) ---
def simple_page(title, message, button_html=""):
    return (
        f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' "
        f"content='width=device-width,initial-scale=1'><title>{title}</title></head>"
        f"<body style='font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;'>"
        f"<h2>{title}</h2><p>{message}</p>{button_html}</body></html>"
    )


@app.route("/api/unsubscribe/<token>", methods=["GET", "POST"])
@limiter.limit("30 per minute")
def unsubscribe(token):
    client = Client.query.filter_by(unsubscribe_token=token).first()
    if not client:
        return simple_page("Link not valid", "This unsubscribe link is invalid or has expired."), 404

    if request.method == "GET":
        # GET only asks for confirmation: mail scanners often open links automatically.
        button = "<form method='post'><button type='submit' style='padding:10px 20px;'>Confirm unsubscribe</button></form>"
        return simple_page("Unsubscribe", "Click the button to stop receiving emails from SecureAI Labs.", button)

    client.status = "unsubscribed"
    db.session.commit()
    log.info("Client %s unsubscribed", client.id)
    return simple_page("You are unsubscribed", "You will no longer receive emails from SecureAI Labs.")


if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG") == "1", port=8000)