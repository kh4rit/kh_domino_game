from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Boolean, ForeignKey, func
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from bot.config import DATABASE_URL
import os

Base = declarative_base()


class Player(Base):
    __tablename__ = "players"

    id = Column(Integer, primary_key=True, autoincrement=True)
    telegram_id = Column(BigInteger, nullable=False)
    group_id = Column(BigInteger, nullable=False)
    username = Column(String, nullable=True)
    display_name = Column(String, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    __table_args__ = (
        # Unique per user per group
        {"sqlite_autoincrement": True},
    )


class Session(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(BigInteger, nullable=False)
    status = Column(String, default="active")  # active, finished
    created_at = Column(DateTime, server_default=func.now())
    finished_at = Column(DateTime, nullable=True)

    games = relationship("Game", back_populates="session")


class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    group_id = Column(BigInteger, nullable=False)
    game_number = Column(Integer, nullable=False)  # 1 or 2 within session
    status = Column(String, default="lobby")  # lobby, active, finished
    winner_telegram_id = Column(BigInteger, nullable=True)  # NULL = fish
    is_fish = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    finished_at = Column(DateTime, nullable=True)

    session = relationship("Session", back_populates="games")


# Engine and session factory
engine = create_async_engine(DATABASE_URL, echo=False)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db():
    """Create all tables."""
    os.makedirs(os.path.dirname(DATABASE_URL.replace("sqlite+aiosqlite:///", "")), exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncSession:
    """Get a new async session."""
    async with async_session_factory() as session:
        yield session
