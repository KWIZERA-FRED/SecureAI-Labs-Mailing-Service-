import os
from flask import Flask, jsonify, request
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from flask_jwt_extended import JWTManager, create_access_token, jwt_required, decode_token
from passlib.context import CryptContext
import requests
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# Configurations for SQLite
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", "sqlite:///secureai_mailing.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["JWT_SECRET_KEY"] = os.getenv("JWT_SECRET_KEY", "super-secret-crypto-key")

# SQLite thread safety configuration for local development
if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite"):
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"connect_args": {"check_same_thread": False}}

db = SQLAlchemy(app)
jwt = JWTManager(app)
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:3000", "http://127.0.0.1:3000"]}})

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

BREVO_API_KEY = os.getenv("BREVO_API_KEY")
CRON_SECRET = os.getenv("CRON_SECRET", "secure-cron-token")
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "newsletter@secureailabs.com")
SENDER_NAME = os.getenv("SENDER_NAME", "SecureAI Labs")

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
    is_sent = db.Column(db.Boolean, default=False, index=True)

# --- Endpoints ---

@app.post("/api/login")
def login():
    data = request.get_json() or {}
    email = data.get("email")
    password = data.get("password")

    admin = Admin.query.filter_by(email=email).first()

    if not admin or not pwd_context.verify(password, admin.password_hash):
        return jsonify({"detail": "Incorrect email or password"}), 401

    access_token = create_access_token(identity=admin.email)
    return jsonify({"access_token": access_token, "token_type": "bearer"})

@app.get("/api/status")
@jwt_required()
def get_status():
    total_clients = Client.query.count()
    sent_clients = Client.query.filter_by(is_sent=True).count()

    return jsonify({
        "total": total_clients,
        "sent": sent_clients,
        "remaining": total_clients - sent_clients
    })

@app.post("/api/send-batch")
def send_batch():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"detail": "Missing authorization header"}), 401
    
    token = auth_header.split(" ")[1]
    is_valid = False

    if token == CRON_SECRET:
        is_valid = True
    else:
        try:
            decode_token(token)
            is_valid = True
        except Exception:
            pass

    if not is_valid:
        return jsonify({"detail": "Invalid or expired token"}), 401

    # Fetch next 300 unsent clients (respecting Brevo free tier limit)
    clients = Client.query.filter_by(is_sent=False).limit(300).all()

    if not clients:
        return jsonify({"message": "All emails have been sent!"})

    sent_count = 0
    for client in clients:
        response = requests.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={
                "accept": "application/json",
                "api-key": BREVO_API_KEY,
                "content-type": "application/json",
            },
            json={
                "sender": {"name": SENDER_NAME, "email": SENDER_EMAIL},
                "to": [{"email": client.email, "name": client.name or "Subscriber"}],
                "subject": "SecureAI Labs Platform Update",
                "htmlContent": "<html><body><p>Hello from SecureAI Labs platform.</p></body></html>"
            },
            timeout=10
        )

        if response.status_code in [200, 201]:
            client.is_sent = True
            db.session.commit()
            sent_count += 1

    return jsonify({"success": True, "sent_count": sent_count})

@app.get("/api/check-email")
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
            "is_sent": client.is_sent
        }), 200
    
    return jsonify({"exists": False}), 200
@app.post("/api/import-clients")
@jwt_required()
def import_clients():
    if 'file' not in request.files:
        return jsonify({"detail": "No file uploaded"}), 400
    
    file = request.files['file']
    stream = io.TextIOWrapper(file.stream, encoding="UTF-8")
    reader = csv.DictReader(stream)

    added_count = 0
    for row in reader:
        email = row.get("email")
        name = row.get("name")
        
        if email and not Client.query.filter_by(email=email).first():
            client = Client(email=email, name=name, is_sent=False)
            db.session.add(client)
            added_count += 1

    db.session.commit()
    return jsonify({"success": True, "added_count": added_count})
if __name__ == "__main__":
    app.run(debug=True, port=8000)