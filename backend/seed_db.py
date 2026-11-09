from app import app, db, Admin, Client
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

with app.app_context():
    db.create_all()

    admin_email = "admin@secureailabs.com"
    if not Admin.query.filter_by(email=admin_email).first():
        hashed_password = pwd_context.hash("AdminPassword123!")
        admin = Admin(email=admin_email, password_hash=hashed_password)
        db.session.add(admin)
        print("Created default admin user: admin@secureailabs.com / AdminPassword123!")

    if Client.query.count() == 0:
        test_clients = [
            Client(email=f"client{i}@example.com", name=f"Client {i}")
            for i in range(1, 11)
        ]
        db.session.add_all(test_clients)
        print("Created 10 test clients.")

    db.session.commit()
    print("SQLite database seeding complete!")