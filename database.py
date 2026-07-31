"""
Configuración de la base de datos SQLite usando SQLAlchemy.
Para migrar a PostgreSQL en el futuro solo hay que cambiar SQLALCHEMY_DATABASE_URL.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

SQLALCHEMY_DATABASE_URL = "sqlite:///./pos.db"
# Ejemplo para PostgreSQL:
# SQLALCHEMY_DATABASE_URL = "postgresql://usuario:password@localhost/pos_db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False}  # necesario solo para SQLite
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """Dependency de FastAPI: entrega una sesión de BD y la cierra al terminar."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
