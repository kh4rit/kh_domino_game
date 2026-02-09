import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
WEB_HOST = os.getenv("WEB_HOST", "0.0.0.0")
WEB_PORT = int(os.getenv("WEB_PORT", "8000"))
BASE_URL = os.getenv("BASE_URL", "")  # Cloudflare tunnel URL, set at runtime
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "domino.db")
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

# Game settings
MIN_PLAYERS = 3
MAX_PLAYERS = 5
LOBBY_TIMEOUT = 60  # seconds
GAMES_PER_SESSION = 2

# Tiles per player by player count
TILES_PER_PLAYER = {
    3: 7,
    4: 5,
    5: 4,
}
