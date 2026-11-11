import csv
import hmac
import html
import io
import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

import requests
import xlrd
from dotenv import load_dotenv
from email_validator import EmailNotValidError, validate_email
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    get_jwt,
    get_jwt_identity,
    jwt_required,
    verify_jwt_in_request,
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_sqlalchemy import SQLAlchemy
from openpyxl import load_workbook
from passlib.context import CryptContext
from sqlalchemy import (
    UniqueConstraint,
    and_,
    func,
    or_,
    select,
    update,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("mailing")


# ---------------------------------------------------------------- configuration

def require_env(name: str, min_length: int = 1) -> str:
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

app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv(
    "DATABASE_URL",
    "sqlite:///secureai_mailing.db"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["JWT_SECRET_KEY"] = require_env(
    "JWT_SECRET_KEY",
    min_length=32
)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite"):
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        "connect_args": {
            "check_same_thread": False,
            "timeout": 30
        }
    }

db = SQLAlchemy(app)
jwt = JWTManager(app)

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if origin.strip()
]

CORS(
    app,
    resources={
        r"/api/*": {
            "origins": CORS_ORIGINS
        }
    }
)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://"
)

pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto"
)

BREVO_API_KEY = os.getenv("BREVO_API_KEY", "")
CRON_SECRET = require_env("CRON_SECRET", min_length=16)

# Updated sender configuration
SENDER_EMAIL = os.getenv(
    "SENDER_EMAIL",
    "journal@secureailabs.org"
)

SENDER_NAME = os.getenv(
    "SENDER_NAME",
    "SecureAI Labs"
)

REPLY_TO_EMAIL = os.getenv(
    "REPLY_TO_EMAIL",
    "journal@secureailabs.org"
)

PUBLIC_API_URL = os.getenv(
    "PUBLIC_API_URL",
    "http://localhost:8000"
).rstrip("/")

# Hard daily limit. Cannot be exceeded. Enforced by _send_lock plus a
# per-send re-check of sent_today() inside the sending loop.
DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "300"))
BATCH_TIME_LIMIT = int(os.getenv("BATCH_TIME_LIMIT_SECONDS", "45"))
MAX_ATTEMPTS = int(os.getenv("MAX_SEND_ATTEMPTS", "3"))
HTTP_RETRIES = 3

ENABLE_SCHEDULER = os.getenv("ENABLE_SCHEDULER", "1") == "1"
SCHEDULER_INTERVAL = int(
    os.getenv("SCHEDULER_INTERVAL_SECONDS", "30")
)
SCHEDULER_BATCH = int(os.getenv("SCHEDULER_BATCH", "20"))

# Serializes send cycles so the daily limit is never exceeded even when
# the scheduler and a manual /send-batch run concurrently.
_send_lock = threading.Lock()


# ---------------------------------------------------------------------- models

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

    is_sent = db.Column(db.Boolean, default=False)
    status = db.Column(
        db.String(20),
        nullable=False,
        default="active",
        index=True
    )

    attempts = db.Column(db.Integer, nullable=False, default=0)
    last_error = db.Column(db.String(500), nullable=True)
    sent_at = db.Column(db.DateTime, nullable=True)

    unsubscribe_token = db.Column(
        db.String(64),
        unique=True,
        index=True,
        default=lambda: secrets.token_urlsafe(24)
    )

    deliveries = db.relationship(
        "Delivery",
        backref="client",
        cascade="all, delete-orphan"
    )


class Campaign(db.Model):
    __tablename__ = "campaigns"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    subject = db.Column(db.String(255), nullable=False)
    body = db.Column(db.Text, nullable=False)

    status = db.Column(
        db.String(20),
        nullable=False,
        default="draft",
        index=True
    )

    created_at = db.Column(
        db.DateTime,
        nullable=False,
        default=utcnow
    )
    started_at = db.Column(db.DateTime, nullable=True)
    completed_at = db.Column(db.DateTime, nullable=True)
    created_by = db.Column(db.String(255), nullable=True)


class Delivery(db.Model):
    __tablename__ = "deliveries"

    __table_args__ = (
        UniqueConstraint(
            "campaign_id",
            "client_id",
            name="uq_delivery_campaign_client"
        ),
        db.Index(
            "ix_delivery_campaign_status",
            "campaign_id",
            "status"
        ),
    )

    id = db.Column(db.Integer, primary_key=True)

    campaign_id = db.Column(
        db.Integer,
        db.ForeignKey("campaigns.id"),
        nullable=False
    )

    client_id = db.Column(
        db.Integer,
        db.ForeignKey("clients.id"),
        nullable=False,
        index=True
    )

    status = db.Column(
        db.String(20),
        nullable=False,
        default="pending"
    )

    attempts = db.Column(db.Integer, nullable=False, default=0)
    last_error = db.Column(db.String(500), nullable=True)
    sent_at = db.Column(db.DateTime, nullable=True, index=True)
    updated_at = db.Column(
        db.DateTime,
        nullable=False,
        default=utcnow
    )


class AuditLog(db.Model):
    __tablename__ = "audit_logs"

    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(
        db.DateTime,
        nullable=False,
        default=utcnow,
        index=True
    )
    actor = db.Column(db.String(255), nullable=False)
    action = db.Column(db.String(60), nullable=False, index=True)
    entity_type = db.Column(db.String(30), nullable=False)
    entity_id = db.Column(db.Integer, nullable=True)
    details = db.Column(db.Text, nullable=True)


# -------------------------------------------------------------------- helpers

def audit(
    action,
    entity_type,
    entity_id=None,
    details=None,
    actor=None
):
    if actor is None:
        try:
            actor = get_jwt_identity() or "system"
        except Exception:
            actor = "system"

    db.session.add(
        AuditLog(
            actor=actor,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=json.dumps(
                details,
                ensure_ascii=False
            ) if details else None,
        )
    )


def normalize_email(raw):
    try:
        return validate_email(
            (raw or "").strip(),
            check_deliverability=False
        ).normalized.lower()
    except (EmailNotValidError, AttributeError, TypeError):
        return None


def clean_name(raw):
    name = (raw or "").strip() if isinstance(raw, str) else ""
    return name[:255] or None


def paginate(query):
    page = max(request.args.get("page", 1, type=int), 1)
    per_page = min(
        max(request.args.get("per_page", 50, type=int), 1),
        200
    )

    total = query.count()
    items = query.offset(
        (page - 1) * per_page
    ).limit(per_page).all()

    return items, {
        "page": page,
        "per_page": per_page,
        "total": total
    }


def iso(dt):
    return dt.isoformat() + "Z" if dt else None


def today_start():
    return utcnow().replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0
    )


def sent_today():
    """Count of successful sends since 00:00 UTC."""
    return Delivery.query.filter(
        Delivery.status == "sent",
        Delivery.sent_at >= today_start()
    ).count()


def brevo_configured():
    return (
        bool(BREVO_API_KEY)
        and not BREVO_API_KEY.startswith("your_")
    )


def current_campaign():
    return (
        Campaign.query.filter_by(status="active").first()
        or Campaign.query.order_by(Campaign.id.desc()).first()
    )


def set_client_status(client, new_status):
    client.status = new_status

    if new_status == "unsubscribed":
        Delivery.query.filter(
            Delivery.client_id == client.id,
            Delivery.status.in_(("pending", "sending"))
        ).update(
            {"status": "skipped"},
            synchronize_session=False
        )


# --------------------------------------------------------------- email content

NAME_TOKEN = re.compile(r"\{\{\s*name\s*\}\}", re.IGNORECASE)
URL_RE = re.compile(r"https?://[^\s<]+")


def fill_name(template, name):
    return NAME_TOKEN.sub(
        lambda _m: name or "there",
        template
    )


def text_to_html(text):
    paragraphs = re.split(r"\n\s*\n", text.strip())
    out = []

    for paragraph in paragraphs:
        escaped = html.escape(paragraph)

        def link(match):
            url = match.group(0)
            trail = ""

            while url and url[-1] in ".,;:!?)":
                trail = url[-1] + trail
                url = url[:-1]

            return f'<a href="{url}">{url}</a>{trail}'

        out.append(
            "<p>"
            + URL_RE.sub(link, escaped).replace("\n", "<br>")
            + "</p>"
        )

    return "\n".join(out)


def render_email(campaign, name, unsubscribe_url):
    body_text = fill_name(campaign.body, name)

    html_body = f"""<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:8px;padding:32px;">
          <tr><td>
            {text_to_html(body_text)}
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
            <p style="font-size:12px;color:#6b7280;">
              You are receiving this email because you are a {html.escape(SENDER_NAME)} contact.
              <a href="{unsubscribe_url}">Unsubscribe</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>"""

    text_body = (
        f"{body_text}\n\n--\n"
        f"Unsubscribe: {unsubscribe_url}\n"
    )

    return html_body, text_body


class BrevoAuthError(Exception):
    """Brevo rejected our API key."""


def send_email(
    to_email,
    to_name,
    subject,
    html_body,
    text_body,
    unsubscribe_url
):
    """Returns (ok, error_message, permanent_failure)."""

    payload = {
        "sender": {
            "name": SENDER_NAME,
            "email": SENDER_EMAIL
        },
        "replyTo": {
            "email": REPLY_TO_EMAIL,
            "name": SENDER_NAME
        },
        "to": [
            {
                "email": to_email,
                "name": to_name or "Subscriber"
            }
        ],
        "subject": subject,
        "htmlContent": html_body,
        "textContent": text_body,
        "headers": {
            "List-Unsubscribe": f"<{unsubscribe_url}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    }

    headers = {
        "accept": "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json"
    }

    error = "unknown error"

    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            response = requests.post(
                "https://api.brevo.com/v3/smtp/email",
                headers=headers,
                json=payload,
                timeout=10
            )

        except requests.RequestException as exc:
            error = f"network error: {type(exc).__name__}"

        else:
            if response.status_code in (200, 201):
                return True, None, False

            if response.status_code in (401, 403):
                raise BrevoAuthError(
                    f"Brevo returned {response.status_code}"
                )

            error = (
                f"Brevo {response.status_code}: "
                f"{response.text[:200]}"
            )

            if (
                400 <= response.status_code < 500
                and response.status_code not in (408, 429)
            ):
                return False, error, True

        if attempt < HTTP_RETRIES:
            time.sleep(2 ** (attempt - 1))

    return False, error, False


# --------------------------------------------------------- audience snapshot

def snapshot_deliveries(campaign, audience, recipient_ids=None):
    if audience not in ("all", "selected"):
        raise ValueError("audience must be 'all' or 'selected'")

    attempted = Delivery.query.filter(
        Delivery.campaign_id == campaign.id,
        Delivery.attempts > 0
    ).count()

    if attempted:
        raise ValueError(
            "Audience is locked: at least one delivery has already been attempted."
        )

    Delivery.query.filter(
        Delivery.campaign_id == campaign.id
    ).delete(synchronize_session=False)

    if audience == "all":
        client_ids = [
            row[0]
            for row in db.session.query(Client.id)
            .filter(Client.status == "active")
            .all()
        ]
    else:
        if not recipient_ids:
            raise ValueError(
                "recipient_ids is required when audience is 'selected'"
            )

        try:
            ids = [int(x) for x in recipient_ids]
        except (TypeError, ValueError):
            raise ValueError("recipient_ids must be a list of integers")

        if not ids:
            raise ValueError(
                "recipient_ids is required when audience is 'selected'"
            )

        client_ids = [
            row[0]
            for row in db.session.query(Client.id)
            .filter(
                Client.id.in_(ids),
                Client.status == "active"
            )
            .all()
        ]

    for cid in client_ids:
        db.session.add(
            Delivery(
                campaign_id=campaign.id,
                client_id=cid,
                status="pending",
                attempts=0,
                updated_at=utcnow(),
            )
        )

    return len(client_ids), len(client_ids)


def backfill_audience_if_empty(campaign):
    if Delivery.query.filter_by(campaign_id=campaign.id).count() == 0:
        snapshot_deliveries(campaign, "all")


# --------------------------------------------------------------- sending engine

def run_send_cycle(limit=None, time_limit=BATCH_TIME_LIMIT):
    """
    Serialized send cycle. Guarantees the daily limit cannot be exceeded
    even if manual and scheduled cycles overlap.
    """
    if not _send_lock.acquire(timeout=time_limit):
        return {
            "success": True,
            "message": "Another sending cycle is already running",
            "sent_count": 0,
            "failed_count": 0
        }, 200
    try:
        return _run_send_cycle_impl(limit, time_limit)
    finally:
        _send_lock.release()


def _run_send_cycle_impl(limit=None, time_limit=BATCH_TIME_LIMIT):
    campaign = Campaign.query.filter_by(status="active").first()

    if campaign is None:
        return {
            "success": True,
            "message": "No active campaign",
            "sent_count": 0,
            "failed_count": 0
        }, 200

    if not brevo_configured():
        return {
            "success": False,
            "detail": "BREVO_API_KEY is not configured on the server"
        }, 500

    # Recover stale "sending" rows.
    Delivery.query.filter(
        Delivery.status == "sending",
        Delivery.updated_at < utcnow() - timedelta(minutes=10)
    ).update(
        {"status": "pending"},
        synchronize_session=False
    )

    db.session.commit()

    done_today = sent_today()
    allowance = DAILY_LIMIT - done_today

    if allowance <= 0:
        return {
            "success": True,
            "message": "Daily limit reached; sending resumes tomorrow (UTC)",
            "sent_count": 0,
            "failed_count": 0,
            "sent_today": done_today,
            "daily_limit": DAILY_LIMIT
        }, 200

    n = allowance if limit is None else min(allowance, limit)

    deliveries = (
        Delivery.query.filter_by(
            campaign_id=campaign.id,
            status="pending"
        )
        .order_by(Delivery.id)
        .limit(n)
        .all()
    )

    deadline = time.monotonic() + time_limit

    sent_count = 0
    failed_count = 0
    stopped = None
    status_code = 200

    for delivery in deliveries:
        if time.monotonic() > deadline:
            stopped = "time limit reached; the next run continues"
            break

        # HARD daily-limit check before each individual send.
        # This is what makes the 300/day cap non-negotiable.
        if sent_today() >= DAILY_LIMIT:
            stopped = "daily limit reached; sending resumes tomorrow (UTC)"
            break

        claimed = db.session.execute(
            update(Delivery)
            .where(
                Delivery.id == delivery.id,
                Delivery.status == "pending"
            )
            .values(
                status="sending",
                updated_at=utcnow()
            )
        ).rowcount

        db.session.commit()

        if not claimed:
            continue

        db.session.refresh(delivery)

        client = delivery.client

        if client is None or client.status != "active":
            delivery.status = "skipped"
            db.session.commit()
            continue

        unsubscribe_url = (
            f"{PUBLIC_API_URL}/api/unsubscribe/"
            f"{client.unsubscribe_token}"
        )

        html_body, text_body = render_email(
            campaign,
            client.name,
            unsubscribe_url
        )

        subject = fill_name(
            campaign.subject,
            client.name
        )

        try:
            ok, error, permanent = send_email(
                client.email,
                client.name,
                subject,
                html_body,
                text_body,
                unsubscribe_url
            )

        except BrevoAuthError as exc:
            delivery.status = "pending"
            campaign.status = "paused"

            audit(
                "campaign.auto_paused",
                "campaign",
                campaign.id,
                {"reason": f"{exc} - check BREVO_API_KEY"},
                actor="system"
            )

            db.session.commit()

            log.error(
                "Campaign %s paused: %s",
                campaign.id,
                exc
            )

            stopped = "Brevo rejected the API key; campaign paused"
            status_code = 502
            break

        delivery.attempts += 1
        delivery.updated_at = utcnow()

        if ok:
            delivery.status = "sent"
            delivery.sent_at = utcnow()
            delivery.last_error = None
            sent_count += 1

        else:
            delivery.last_error = (error or "")[:500]

            if permanent or delivery.attempts >= MAX_ATTEMPTS:
                delivery.status = "failed"
                failed_count += 1
            else:
                delivery.status = "pending"

            log.warning(
                "Delivery %s failed (attempt %s): %s",
                delivery.id,
                delivery.attempts,
                error
            )

        db.session.commit()

    remaining = Delivery.query.filter(
        Delivery.campaign_id == campaign.id,
        Delivery.status.in_(("pending", "sending"))
    ).count()

    if (
        remaining == 0
        and stopped is None
        and campaign.status == "active"
    ):
        campaign.status = "completed"
        campaign.completed_at = utcnow()

        audit(
            "campaign.completed",
            "campaign",
            campaign.id,
            actor="system"
        )

        db.session.commit()

        log.info("Campaign %s completed", campaign.id)

    log.info(
        "Cycle: sent=%s failed=%s remaining=%s sent_today=%s",
        sent_count,
        failed_count,
        remaining,
        sent_today()
    )

    result = {
        "success": stopped is None,
        "sent_count": sent_count,
        "failed_count": failed_count,
        "remaining": remaining,
        "sent_today": sent_today(),
        "daily_limit": DAILY_LIMIT,
        "remaining_today": max(DAILY_LIMIT - sent_today(), 0)
    }

    if stopped:
        result["stopped_reason"] = stopped

    return result, status_code


_scheduler_started = False


def start_scheduler():
    global _scheduler_started

    if _scheduler_started or not ENABLE_SCHEDULER:
        return

    _scheduler_started = True

    def loop():
        while True:
            time.sleep(SCHEDULER_INTERVAL)

            try:
                with app.app_context():
                    run_send_cycle(
                        limit=SCHEDULER_BATCH,
                        time_limit=SCHEDULER_INTERVAL * 2
                    )

            except Exception:
                log.exception("Scheduler cycle failed")

    threading.Thread(
        target=loop,
        name="mail-scheduler",
        daemon=True
    ).start()

    log.info(
        "Scheduler started: up to %s emails every %ss, daily limit %s",
        SCHEDULER_BATCH,
        SCHEDULER_INTERVAL,
        DAILY_LIMIT
    )


# ------------------------------------------------------------------ auth + misc

def is_cron_request() -> bool:
    header = request.headers.get("Authorization", "")

    if not header.startswith("Bearer "):
        return False

    supplied = header[len("Bearer "):]

    return hmac.compare_digest(
        supplied.encode(),
        CRON_SECRET.encode()
    )


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"detail": "Not found"}), 404


@app.errorhandler(405)
def method_not_allowed(_e):
    return jsonify({"detail": "Method not allowed"}), 405


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"detail": "File too large (max 5 MB)"}), 413


@app.errorhandler(429)
def rate_limited(_e):
    return jsonify({"detail": "Too many requests, slow down"}), 429


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.post("/api/login")
@limiter.limit("5 per minute")
def login():
    data = request.get_json(silent=True) or {}

    email = data.get("email")
    password = data.get("password")

    if not isinstance(email, str) or not isinstance(password, str):
        return jsonify({
            "detail": "Email and password are required"
        }), 400

    admin = Admin.query.filter_by(email=email).first()

    if (
        not admin
        or not pwd_context.verify(
            password,
            admin.password_hash
        )
    ):
        return jsonify({
            "detail": "Incorrect email or password"
        }), 401

    return jsonify({
        "access_token": create_access_token(
            identity=admin.email
        ),
        "token_type": "bearer"
    })


# ------------------------------------------------------------------- dashboard

def campaign_stats(campaign):
    rows = (
        db.session.query(
            Delivery.status,
            func.count()
        )
        .filter(
            Delivery.campaign_id == campaign.id
        )
        .group_by(Delivery.status)
        .all()
    )

    stats = {
        status: 0
        for status in (
            "pending",
            "sending",
            "sent",
            "failed",
            "skipped"
        )
    }

    stats.update(dict(rows))
    stats["total"] = sum(stats.values())
    stats["not_received"] = stats["total"] - stats["sent"]

    return stats


@app.get("/api/status")
@jwt_required()
def get_status():
    campaign = current_campaign()

    active_clients = Client.query.filter_by(
        status="active"
    ).count()

    done_today = sent_today()

    body = {
        "total": Client.query.count(),
        "active_clients": active_clients,
        "unsubscribed": Client.query.filter_by(
            status="unsubscribed"
        ).count(),
        "daily_limit": DAILY_LIMIT,
        "sent_today": done_today,
        "remaining_today": max(DAILY_LIMIT - done_today, 0),
        "sent": 0,
        "remaining": 0,
        "failed": 0,
        "campaign": None
    }

    if campaign:
        stats = campaign_stats(campaign)

        if campaign.status in ("active", "paused"):
            work_remaining = stats["pending"] + stats["sending"]
        else:
            work_remaining = 0

        body.update({
            "sent": stats["sent"],
            "failed": stats["failed"],
            "remaining": work_remaining
        })

        body["campaign"] = {
            "id": campaign.id,
            "name": campaign.name,
            "status": campaign.status,
            "stats": stats
        }

        body["estimated_days_left"] = (
            -(-work_remaining // DAILY_LIMIT)
            if work_remaining and DAILY_LIMIT
            else 0
        )

    return jsonify(body)


@app.post("/api/send-batch")
@limiter.limit("30 per hour")
def send_batch():
    if not is_cron_request():
        try:
            verify_jwt_in_request()
        except Exception:
            return jsonify({
                "detail": "Invalid or missing credentials"
            }), 401

        if get_jwt().get("type") != "access":
            return jsonify({
                "detail": "Access token required"
            }), 401

    result, code = run_send_cycle()

    return jsonify(result), code


# --------------------------------------------------------------------- clients

def client_dict(client, delivery_status=None):
    return {
        "id": client.id,
        "email": client.email,
        "name": client.name,
        "status": client.status,
        "delivery_status": delivery_status
    }


@app.get("/api/clients")
@jwt_required()
def list_clients():
    campaign = current_campaign()

    campaign_id = (
        request.args.get("campaign_id", type=int)
        or (campaign.id if campaign else -1)
    )

    query = db.session.query(
        Client,
        Delivery.status
    ).outerjoin(
        Delivery,
        and_(
            Delivery.client_id == Client.id,
            Delivery.campaign_id == campaign_id
        )
    )

    search = (request.args.get("q") or "").strip()

    if search:
        like = f"%{search}%"

        query = query.filter(
            or_(
                Client.email.ilike(like),
                Client.name.ilike(like)
            )
        )

    status = request.args.get("status")

    if status in ("active", "unsubscribed"):
        query = query.filter(Client.status == status)

    delivery = request.args.get("delivery")

    if delivery == "none":
        query = query.filter(Delivery.status.is_(None))
    elif delivery in (
        "pending", "sending", "sent", "failed", "skipped"
    ):
        query = query.filter(Delivery.status == delivery)

    items, meta = paginate(query.order_by(Client.id))

    return jsonify({
        "items": [
            client_dict(client, delivery_status)
            for client, delivery_status in items
        ],
        "campaign_id": campaign_id,
        **meta
    })


@app.get("/api/clients/<int:client_id>")
@jwt_required()
def get_client(client_id):
    client = db.session.get(Client, client_id)

    if not client:
        return jsonify({"detail": "Client not found"}), 404

    deliveries = (
        db.session.query(Delivery, Campaign.name)
        .join(Campaign, Campaign.id == Delivery.campaign_id)
        .filter(Delivery.client_id == client.id)
        .order_by(Delivery.id.desc())
        .all()
    )

    return jsonify({
        **client_dict(client),
        "deliveries": [
            {
                "campaign_id": delivery.campaign_id,
                "campaign": campaign_name,
                "status": delivery.status,
                "attempts": delivery.attempts,
                "last_error": delivery.last_error,
                "sent_at": iso(delivery.sent_at)
            }
            for delivery, campaign_name in deliveries
        ]
    })


@app.post("/api/clients")
@jwt_required()
def create_client():
    data = request.get_json(silent=True) or {}

    email = normalize_email(data.get("email"))

    if not email:
        return jsonify({
            "detail": "A valid email is required"
        }), 400

    existing = Client.query.filter(
        func.lower(Client.email) == email
    ).first()

    if existing:
        return jsonify({
            "detail": "This email already exists"
        }), 409

    client = Client(
        email=email,
        name=clean_name(data.get("name"))
    )

    db.session.add(client)
    db.session.flush()

    audit(
        "client.created",
        "client",
        client.id,
        {"email": client.email, "name": client.name}
    )

    db.session.commit()

    return jsonify(client_dict(client)), 201


@app.put("/api/clients/<int:client_id>")
@jwt_required()
def update_client(client_id):
    client = db.session.get(Client, client_id)

    if not client:
        return jsonify({"detail": "Client not found"}), 404

    data = request.get_json(silent=True) or {}
    changes = {}

    if "email" in data:
        email = normalize_email(data["email"])

        if not email:
            return jsonify({
                "detail": "A valid email is required"
            }), 400

        clash = Client.query.filter(
            func.lower(Client.email) == email,
            Client.id != client.id
        ).first()

        if clash:
            return jsonify({
                "detail": "Another client already uses this email"
            }), 409

        if email != client.email:
            changes["email"] = {"from": client.email, "to": email}
            client.email = email

    if "name" in data:
        name = clean_name(data["name"])

        if name != client.name:
            changes["name"] = {"from": client.name, "to": name}
            client.name = name

    if "status" in data:
        new_status = data["status"]

        if new_status not in ("active", "unsubscribed"):
            return jsonify({
                "detail": "status must be 'active' or 'unsubscribed'"
            }), 400

        if (
            new_status == "active"
            and client.status == "unsubscribed"
            and data.get("confirm_resubscribe") is not True
        ):
            return jsonify({
                "detail": (
                    "This person unsubscribed. Re-activating needs "
                    '"confirm_resubscribe": true '
                    "(only do this if they asked to be added back)."
                )
            }), 400

        if new_status != client.status:
            changes["status"] = {
                "from": client.status,
                "to": new_status
            }
            set_client_status(client, new_status)

    if changes:
        audit(
            "client.updated",
            "client",
            client.id,
            {"changes": changes}
        )
        db.session.commit()

    return jsonify(client_dict(client))


@app.delete("/api/clients/<int:client_id>")
@jwt_required()
def delete_client(client_id):
    client = db.session.get(Client, client_id)

    if not client:
        return jsonify({"detail": "Client not found"}), 404

    audit(
        "client.deleted",
        "client",
        client.id,
        {"email": client.email, "name": client.name}
    )

    db.session.delete(client)
    db.session.commit()

    return jsonify({"success": True})


@app.get("/api/check-email")
@jwt_required()
def check_email():
    email = normalize_email(request.args.get("email"))

    if not email:
        return jsonify({
            "error": "A valid email parameter is required"
        }), 400

    client = Client.query.filter(
        func.lower(Client.email) == email
    ).first()

    if client:
        return jsonify({"exists": True, **client_dict(client)}), 200

    return jsonify({"exists": False}), 200


# ------------------------------------------------------------- contact importer

def read_contact_upload(uploaded_file):
    filename = (uploaded_file.filename or "").strip()
    extension = os.path.splitext(filename)[1].lower()

    if extension not in (".csv", ".xlsx", ".xls"):
        raise ValueError(
            "Unsupported file type. Upload a CSV, XLSX, or XLS file."
        )

    rows = []

    if extension == ".csv":
        try:
            stream = io.TextIOWrapper(
                uploaded_file.stream,
                encoding="utf-8-sig",
                errors="replace",
                newline=""
            )

            reader = csv.DictReader(stream)

            if not reader.fieldnames:
                raise ValueError(
                    "The CSV file is empty or has no header row."
                )

            headers = {
                str(header).strip().lower(): header
                for header in reader.fieldnames
                if header is not None
            }

            if "email" not in headers:
                raise ValueError(
                    "The CSV file must contain an 'email' column."
                )

            for row in reader:
                rows.append({
                    "email": row.get(headers["email"]),
                    "name": (
                        row.get(headers["name"])
                        if "name" in headers
                        else None
                    )
                })

        except UnicodeError as exc:
            raise ValueError(
                "Could not read the CSV file encoding."
            ) from exc

    elif extension == ".xlsx":
        workbook = None
        try:
            workbook = load_workbook(
                uploaded_file,
                read_only=True,
                data_only=True
            )

            worksheet = workbook.active
            iterator = worksheet.iter_rows(values_only=True)
            header_row = next(iterator, None)

            if not header_row:
                raise ValueError("The Excel file is empty.")

            headers = {
                str(value).strip().lower(): index
                for index, value in enumerate(header_row)
                if value is not None
            }

            if "email" not in headers:
                raise ValueError(
                    "The Excel file must contain an 'email' column."
                )

            for row in iterator:
                email_index = headers["email"]
                email_value = (
                    row[email_index]
                    if email_index < len(row)
                    else None
                )

                name_value = None
                if "name" in headers:
                    name_index = headers["name"]
                    if name_index < len(row):
                        name_value = row[name_index]

                rows.append({
                    "email": (
                        str(email_value).strip()
                        if email_value is not None else None
                    ),
                    "name": (
                        str(name_value).strip()
                        if name_value is not None else None
                    )
                })

        except ValueError:
            raise

        except Exception as exc:
            raise ValueError(
                "Could not read the XLSX file. Check that it is a valid Excel workbook."
            ) from exc

        finally:
            if workbook is not None:
                workbook.close()

    elif extension == ".xls":
        try:
            workbook_data = uploaded_file.read()
            workbook = xlrd.open_workbook(file_contents=workbook_data)

            if workbook.nsheets == 0:
                raise ValueError(
                    "The Excel file does not contain a worksheet."
                )

            worksheet = workbook.sheet_by_index(0)

            if worksheet.nrows == 0:
                raise ValueError("The Excel file is empty.")

            headers = {
                str(worksheet.cell_value(0, column))
                .strip()
                .lower(): column
                for column in range(worksheet.ncols)
                if str(worksheet.cell_value(0, column)).strip()
            }

            if "email" not in headers:
                raise ValueError(
                    "The Excel file must contain an 'email' column."
                )

            for row_index in range(1, worksheet.nrows):
                email_value = worksheet.cell_value(
                    row_index, headers["email"]
                )
                name_value = None
                if "name" in headers:
                    name_value = worksheet.cell_value(
                        row_index, headers["name"]
                    )

                rows.append({
                    "email": (
                        str(email_value).strip()
                        if email_value not in (None, "") else None
                    ),
                    "name": (
                        str(name_value).strip()
                        if name_value not in (None, "") else None
                    )
                })

        except ValueError:
            raise

        except Exception as exc:
            raise ValueError(
                "Could not read the XLS file. Check that it is a valid Excel 97-2003 workbook."
            ) from exc

    return rows


@app.post("/api/import-clients")
@jwt_required()
def import_clients():
    if "file" not in request.files:
        return jsonify({"detail": "No file uploaded"}), 400

    uploaded_file = request.files["file"]

    if not uploaded_file or not uploaded_file.filename:
        return jsonify({
            "detail": "Please select a file to upload."
        }), 400

    try:
        rows = read_contact_upload(uploaded_file)

        known_emails = {
            email.lower()
            for (email,) in db.session.query(Client.email).all()
        }

        added = 0
        skipped_invalid = 0
        skipped_existing = 0

        for row in rows:
            email = normalize_email(row.get("email"))

            if not email:
                skipped_invalid += 1
                continue

            email_key = email.lower()

            if email_key in known_emails:
                skipped_existing += 1
                continue

            known_emails.add(email_key)

            client = Client(
                email=email,
                name=clean_name(row.get("name")),
                status="active"
            )

            db.session.add(client)
            added += 1

        audit(
            "clients.imported",
            "client",
            None,
            {
                "filename": uploaded_file.filename,
                "file_type": os.path.splitext(
                    uploaded_file.filename
                )[1].lower(),
                "total_rows": len(rows),
                "added": added,
                "skipped_invalid": skipped_invalid,
                "skipped_existing": skipped_existing
            }
        )

        db.session.commit()

        return jsonify({
            "success": True,
            "filename": uploaded_file.filename,
            "total_rows": len(rows),
            "added_count": added,
            "skipped_invalid": skipped_invalid,
            "skipped_existing": skipped_existing
        }), 200

    except ValueError as exc:
        db.session.rollback()
        return jsonify({"detail": str(exc)}), 400

    except Exception:
        db.session.rollback()
        log.exception("Contact import failed")
        return jsonify({
            "detail": (
                "Import failed because of an unexpected error. "
                "Check the backend logs and verify the file."
            )
        }), 500


# ------------------------------------------------------------------- campaigns

def campaign_dict(campaign, stats=False, with_recipients=False):
    data = {
        "id": campaign.id,
        "name": campaign.name,
        "subject": campaign.subject,
        "body": campaign.body,
        "status": campaign.status,
        "created_at": iso(campaign.created_at),
        "started_at": iso(campaign.started_at),
        "completed_at": iso(campaign.completed_at),
        "created_by": campaign.created_by
    }

    if stats:
        st = campaign_stats(campaign)
        data["stats"] = st
        data["recipient_count"] = st["total"]
        data["sent_count"] = st["sent"]
        data["not_received_count"] = st["not_received"]

    if with_recipients:
        data["recipient_ids"] = [
            row[0]
            for row in db.session.query(Delivery.client_id)
            .filter(Delivery.campaign_id == campaign.id)
            .all()
        ]

    return data


def validate_campaign(data, partial=False):
    output = {}

    for field, limit in (
        ("name", 200),
        ("subject", 255),
        ("body", 20000)
    ):
        if field in data or not partial:
            value = data.get(field)

            if not isinstance(value, str) or not value.strip():
                return None, f"'{field}' is required"

            if len(value) > limit:
                return None, (
                    f"'{field}' is too long (max {limit} characters)"
                )

            output[field] = value.strip()

    return output, None


def get_campaign_or_404(campaign_id):
    return db.session.get(Campaign, campaign_id)


def _parse_audience(body):
    audience = body.get("audience", "all")
    recipient_ids = body.get("recipient_ids")

    if audience not in ("all", "selected"):
        return None, None, "audience must be 'all' or 'selected'"

    if audience == "selected":
        if not isinstance(recipient_ids, list) or not recipient_ids:
            return None, None, (
                "recipient_ids is required when audience is 'selected'"
            )

    return audience, recipient_ids, None


@app.get("/api/campaigns")
@jwt_required()
def list_campaigns():
    campaigns = Campaign.query.order_by(Campaign.id.desc()).all()

    return jsonify([
        campaign_dict(campaign, stats=True)
        for campaign in campaigns
    ])


@app.post("/api/campaigns")
@jwt_required()
def create_campaign():
    body = request.get_json(silent=True) or {}

    fields, error = validate_campaign(body)
    if error:
        return jsonify({"detail": error}), 400

    audience, recipient_ids, audience_error = _parse_audience(body)
    if audience_error:
        return jsonify({"detail": audience_error}), 400

    campaign = Campaign(
        **fields,
        created_by=get_jwt_identity()
    )

    db.session.add(campaign)
    db.session.flush()

    try:
        added, total = snapshot_deliveries(
            campaign, audience, recipient_ids
        )
    except ValueError as exc:
        db.session.rollback()
        return jsonify({"detail": str(exc)}), 400

    audit(
        "campaign.created",
        "campaign",
        campaign.id,
        {
            "name": campaign.name,
            "subject": campaign.subject,
            "audience": audience,
            "recipients": total
        }
    )

    db.session.commit()

    return jsonify(campaign_dict(campaign, stats=True)), 201


@app.get("/api/campaigns/<int:campaign_id>")
@jwt_required()
def get_campaign(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    return jsonify(
        campaign_dict(campaign, stats=True, with_recipients=True)
    )


@app.put("/api/campaigns/<int:campaign_id>")
@jwt_required()
def update_campaign(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    fields, error = validate_campaign(
        request.get_json(silent=True) or {},
        partial=True
    )

    if error:
        return jsonify({"detail": error}), 400

    changes = {}

    for key, value in fields.items():
        old_value = getattr(campaign, key)

        if old_value != value:
            changes[key] = (
                {"from": old_value, "to": value}
                if key != "body"
                else "changed"
            )
            setattr(campaign, key, value)

    if changes:
        audit(
            "campaign.updated",
            "campaign",
            campaign.id,
            {"changes": changes}
        )
        db.session.commit()

    return jsonify(campaign_dict(campaign, stats=True))


@app.put("/api/campaigns/<int:campaign_id>/audience")
@jwt_required()
def update_campaign_audience(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    if campaign.status != "draft":
        return jsonify({
            "detail": (
                f"Audience is locked: campaign is '{campaign.status}', "
                "not 'draft'"
            )
        }), 409

    body = request.get_json(silent=True) or {}
    audience, recipient_ids, error = _parse_audience(body)

    if error:
        return jsonify({"detail": error}), 400

    try:
        added, total = snapshot_deliveries(
            campaign, audience, recipient_ids
        )
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 409

    audit(
        "campaign.audience_updated",
        "campaign",
        campaign.id,
        {"audience": audience, "recipients": total}
    )

    db.session.commit()

    return jsonify(
        campaign_dict(campaign, stats=True, with_recipients=True)
    )


@app.get("/api/campaigns/<int:campaign_id>/preview")
@jwt_required()
def preview_campaign(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    sample = request.args.get("name") or "Alex"
    url = f"{PUBLIC_API_URL}/api/unsubscribe/preview"

    html_body, text_body = render_email(campaign, sample, url)

    return jsonify({
        "subject": fill_name(campaign.subject, sample),
        "html": html_body,
        "text": text_body
    })


@app.post("/api/campaigns/<int:campaign_id>/test")
@jwt_required()
@limiter.limit("20 per hour")
def test_campaign(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    if not brevo_configured():
        return jsonify({
            "detail": "BREVO_API_KEY is not configured on the server"
        }), 400

    email = normalize_email(
        (request.get_json(silent=True) or {}).get("email")
    )

    if not email:
        return jsonify({
            "detail": "A valid email is required"
        }), 400

    url = f"{PUBLIC_API_URL}/api/unsubscribe/preview"
    html_body, text_body = render_email(campaign, "Test", url)

    try:
        ok, error, _ = send_email(
            email,
            "Test",
            "[TEST] " + fill_name(campaign.subject, "Test"),
            html_body,
            text_body,
            url
        )

    except BrevoAuthError:
        return jsonify({"detail": "Brevo rejected the API key"}), 502

    if not ok:
        return jsonify({"detail": error}), 502

    audit(
        "campaign.test_sent",
        "campaign",
        campaign.id,
        {"to": email}
    )

    db.session.commit()

    return jsonify({"success": True})


@app.post("/api/campaigns/<int:campaign_id>/start")
@app.post("/api/campaigns/<int:campaign_id>/resume")
@jwt_required()
def start_campaign(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    if campaign.status == "active":
        return jsonify({
            "detail": "Campaign is already running"
        }), 409

    other = Campaign.query.filter(
        Campaign.status == "active",
        Campaign.id != campaign.id
    ).first()

    if other:
        return jsonify({
            "detail": (
                f"Campaign '{other.name}' is already running. "
                "Pause it first."
            )
        }), 409

    if not brevo_configured():
        return jsonify({
            "detail": "BREVO_API_KEY is not configured on the server"
        }), 400

    if campaign.status == "draft" and Delivery.query.filter_by(
        campaign_id=campaign.id
    ).count() == 0:
        backfill_audience_if_empty(campaign)
        db.session.commit()

    pending = Delivery.query.filter_by(
        campaign_id=campaign.id, status="pending"
    ).count()

    if pending == 0:
        return jsonify({
            "detail": (
                "Campaign has no pending recipients. "
                "Set an audience before starting."
            )
        }), 400

    previous = campaign.status

    campaign.status = "active"
    if not campaign.started_at:
        campaign.started_at = utcnow()
    campaign.completed_at = None

    audit(
        "campaign.started" if previous == "draft" else "campaign.resumed",
        "campaign",
        campaign.id,
        {"from": previous}
    )

    db.session.commit()

    return jsonify(campaign_dict(campaign, stats=True))


@app.post("/api/campaigns/<int:campaign_id>/pause")
@jwt_required()
def pause_campaign(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    if campaign.status != "active":
        return jsonify({
            "detail": "Campaign is not running"
        }), 409

    campaign.status = "paused"

    audit("campaign.paused", "campaign", campaign.id)
    db.session.commit()

    return jsonify(campaign_dict(campaign, stats=True))


@app.post("/api/campaigns/<int:campaign_id>/retry-failed")
@jwt_required()
def retry_failed(campaign_id):
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    active_ids = select(Client.id).where(Client.status == "active")

    count = Delivery.query.filter(
        Delivery.campaign_id == campaign.id,
        Delivery.status == "failed",
        Delivery.client_id.in_(active_ids),
    ).update(
        {
            "status": "pending",
            "attempts": 0,
            "last_error": None
        },
        synchronize_session=False
    )

    if count and campaign.status == "completed":
        campaign.status = "active"
        campaign.completed_at = None

    audit(
        "campaign.retry_failed",
        "campaign",
        campaign.id,
        {"requeued": count}
    )

    db.session.commit()

    return jsonify({"success": True, "requeued": count})


@app.get("/api/campaigns/<int:campaign_id>/deliveries")
@jwt_required()
def list_deliveries(campaign_id):
    """
    Delivery log.

    Query params:
      group=received | not_received  (mutually exclusive with 'status')
      status=pending|sending|sent|failed|skipped
      q=<search>
      page, per_page

    Response includes:
      items: per-delivery rows with a `received` boolean
      summary: full status counts for this campaign (unaffected by filters)
      campaign: {id, name, status}
    """
    campaign = get_campaign_or_404(campaign_id)

    if not campaign:
        return jsonify({"detail": "Campaign not found"}), 404

    query = (
        db.session.query(Delivery, Client)
        .join(Client, Client.id == Delivery.client_id)
        .filter(Delivery.campaign_id == campaign.id)
    )

    group = request.args.get("group")
    if group == "received":
        query = query.filter(Delivery.status == "sent")
    elif group == "not_received":
        query = query.filter(
            Delivery.status.in_(
                ("pending", "sending", "failed", "skipped")
            )
        )

    status = request.args.get("status")
    if status in (
        "pending", "sending", "sent", "failed", "skipped"
    ):
        query = query.filter(Delivery.status == status)

    search = (request.args.get("q") or "").strip()
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                Client.email.ilike(like),
                Client.name.ilike(like)
            )
        )

    items, meta = paginate(query.order_by(Delivery.id))

    summary = campaign_stats(campaign)

    return jsonify({
        "items": [
            {
                "id": delivery.id,
                "client_id": client.id,
                "email": client.email,
                "name": client.name,
                "status": delivery.status,
                "received": delivery.status == "sent",
                "attempts": delivery.attempts,
                "last_error": delivery.last_error,
                "sent_at": iso(delivery.sent_at)
            }
            for delivery, client in items
        ],
        "summary": summary,
        "campaign": {
            "id": campaign.id,
            "name": campaign.name,
            "status": campaign.status
        },
        **meta
    })


# ------------------------------------------------------------------- audit log

@app.get("/api/audit")
@jwt_required()
def list_audit():
    query = AuditLog.query

    if request.args.get("entity_type"):
        query = query.filter(
            AuditLog.entity_type == request.args["entity_type"]
        )

    entity_id = request.args.get("entity_id", type=int)
    if entity_id is not None:
        query = query.filter(AuditLog.entity_id == entity_id)

    if request.args.get("action"):
        query = query.filter(
            AuditLog.action == request.args["action"]
        )

    items, meta = paginate(query.order_by(AuditLog.id.desc()))

    return jsonify({
        "items": [
            {
                "id": item.id,
                "at": iso(item.created_at),
                "actor": item.actor,
                "action": item.action,
                "entity_type": item.entity_type,
                "entity_id": item.entity_id,
                "details": (
                    json.loads(item.details)
                    if item.details else None
                )
            }
            for item in items
        ],
        **meta
    })


# ----------------------------------------------------- public unsubscribe page

def simple_page(title, message, button_html=""):
    return (
        f"<!doctype html><html><head><meta charset='utf-8'>"
        f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{html.escape(title)}</title></head>"
        f"<body style='font-family:Arial,sans-serif;max-width:480px;"
        f"margin:80px auto;padding:0 16px;'>"
        f"<h2>{html.escape(title)}</h2>"
        f"<p>{html.escape(message)}</p>"
        f"{button_html}</body></html>"
    )


@app.route(
    "/api/unsubscribe/<token>",
    methods=["GET", "POST"]
)
@limiter.limit("30 per minute")
def unsubscribe(token):
    client = Client.query.filter_by(
        unsubscribe_token=token
    ).first()

    if not client:
        return simple_page(
            "Link not valid",
            "This unsubscribe link is invalid or has expired."
        ), 404

    if request.method == "GET":
        button = (
            "<form method='post'>"
            "<button type='submit' "
            "style='padding:10px 20px;'>"
            "Confirm unsubscribe"
            "</button>"
            "</form>"
        )
        return simple_page(
            "Unsubscribe",
            "Click the button to stop receiving emails.",
            button
        )

    if client.status != "unsubscribed":
        set_client_status(client, "unsubscribed")

        audit(
            "client.unsubscribed",
            "client",
            client.id,
            {"email": client.email},
            actor="subscriber"
        )

        db.session.commit()

    return simple_page(
        "You are unsubscribed",
        "You will no longer receive emails from us."
    )


# ---------------------------------------------------------------------- startup

# Start the scheduler for production (Gunicorn)
if os.getenv("ENABLE_SCHEDULER", "1") == "1":
    start_scheduler()

if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG") == "1"

    app.run(debug=debug, port=8000)