"""
Manages active game sessions, lobbies, and lifecycle.
Acts as the bridge between the Telegram bot, the web server, and the game engine.
"""

import asyncio
import time
import logging
from dataclasses import dataclass, field
from typing import Optional, Callable, Awaitable

from bot.game_engine import DominoEngine, Tile
from bot.config import MIN_PLAYERS, MAX_PLAYERS, LOBBY_TIMEOUT, GAMES_PER_SESSION

logger = logging.getLogger(__name__)


@dataclass
class LobbyPlayer:
    telegram_id: int
    display_name: str
    username: Optional[str] = None


@dataclass
class Lobby:
    game_id: str
    group_id: int
    players: list[LobbyPlayer] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    timer_task: Optional[asyncio.Task] = None
    message_id: Optional[int] = None  # Bot message to update


@dataclass
class ActiveSession:
    session_id: str
    group_id: int
    game_id: str  # Current game ID
    game_number: int  # 1 or 2
    player_infos: list[dict]  # Original player infos for restarting
    engine: Optional[DominoEngine] = None
    results: list[dict] = field(default_factory=list)  # Results of each game


class GameManager:
    """Singleton managing all active games and lobbies."""

    def __init__(self):
        self.lobbies: dict[str, Lobby] = {}          # game_id -> Lobby
        self.sessions: dict[str, ActiveSession] = {}  # game_id -> ActiveSession
        self.group_lobbies: dict[int, str] = {}       # group_id -> game_id (one lobby per group)
        self.group_sessions: dict[int, str] = {}      # group_id -> game_id (one active session per group)

        # Callbacks
        self._on_lobby_timeout: Optional[Callable] = None
        self._on_game_start: Optional[Callable] = None
        self._on_game_end: Optional[Callable] = None
        self._on_session_end: Optional[Callable] = None
        self._ws_broadcast: Optional[Callable] = None

        self._id_counter = 0

    def set_callbacks(
        self,
        on_lobby_timeout: Optional[Callable] = None,
        on_game_start: Optional[Callable] = None,
        on_game_end: Optional[Callable] = None,
        on_session_end: Optional[Callable] = None,
        ws_broadcast: Optional[Callable] = None,
    ):
        self._on_lobby_timeout = on_lobby_timeout
        self._on_game_start = on_game_start
        self._on_game_end = on_game_end
        self._on_session_end = on_session_end
        self._ws_broadcast = ws_broadcast

    def _next_id(self) -> str:
        self._id_counter += 1
        return f"game_{int(time.time())}_{self._id_counter}"

    def create_lobby(self, group_id: int, creator: LobbyPlayer) -> tuple[Optional[str], str]:
        """
        Create a new lobby in a group.
        Returns (game_id, message) or (None, error_message).
        """
        # Check if there's already an active lobby or game in this group
        if group_id in self.group_lobbies:
            return None, "There's already a game lobby open in this group!"
        if group_id in self.group_sessions:
            return None, "There's already a game in progress in this group!"

        game_id = self._next_id()
        lobby = Lobby(game_id=game_id, group_id=group_id, players=[creator])
        self.lobbies[game_id] = lobby
        self.group_lobbies[group_id] = game_id

        return game_id, f"{creator.display_name} started a game! Waiting for players..."

    def join_lobby(self, game_id: str, player: LobbyPlayer) -> tuple[bool, str]:
        """
        Join an existing lobby.
        Returns (success, message).
        """
        lobby = self.lobbies.get(game_id)
        if not lobby:
            return False, "Lobby not found."

        # Check if player is already in the lobby
        for p in lobby.players:
            if p.telegram_id == player.telegram_id:
                return False, f"{player.display_name} is already in the game!"

        if len(lobby.players) >= MAX_PLAYERS:
            return False, "Game is full (5 players max)!"

        lobby.players.append(player)
        count = len(lobby.players)
        return True, f"{player.display_name} joined! ({count}/{MAX_PLAYERS} players)"

    def can_start(self, game_id: str) -> bool:
        """Check if a lobby has enough players to start."""
        lobby = self.lobbies.get(game_id)
        return lobby is not None and len(lobby.players) >= MIN_PLAYERS

    def start_game(self, game_id: str) -> tuple[bool, str, Optional[ActiveSession]]:
        """
        Start the game from a lobby.
        Returns (success, message, session).
        """
        lobby = self.lobbies.get(game_id)
        if not lobby:
            return False, "Lobby not found.", None

        if len(lobby.players) < MIN_PLAYERS:
            return False, f"Need at least {MIN_PLAYERS} players to start.", None

        # Cancel the timer if running
        if lobby.timer_task and not lobby.timer_task.done():
            lobby.timer_task.cancel()

        # Create session
        player_infos = [
            {"telegram_id": p.telegram_id, "display_name": p.display_name}
            for p in lobby.players
        ]

        session_id = game_id  # Reuse the lobby game_id as session_id
        engine = DominoEngine(player_infos)

        session = ActiveSession(
            session_id=session_id,
            group_id=lobby.group_id,
            game_id=game_id,
            game_number=1,
            player_infos=player_infos,
            engine=engine,
        )

        # Clean up lobby, set up session
        del self.lobbies[game_id]
        del self.group_lobbies[lobby.group_id]
        self.sessions[game_id] = session
        self.group_sessions[lobby.group_id] = game_id

        player_names = ", ".join(p.display_name for p in lobby.players)
        return True, f"Game started! Players: {player_names}", session

    def start_lobby_timer(self, game_id: str):
        """Start the 60-second countdown for a lobby."""
        lobby = self.lobbies.get(game_id)
        if lobby and not lobby.timer_task:
            lobby.timer_task = asyncio.create_task(self._lobby_countdown(game_id))

    async def _lobby_countdown(self, game_id: str):
        """Wait for lobby timeout, then auto-start or cancel."""
        try:
            await asyncio.sleep(LOBBY_TIMEOUT)
        except asyncio.CancelledError:
            return

        lobby = self.lobbies.get(game_id)
        if not lobby:
            return

        if len(lobby.players) >= MIN_PLAYERS:
            # Auto-start
            if self._on_lobby_timeout:
                await self._on_lobby_timeout(game_id, "start")
        else:
            # Cancel
            self._cleanup_lobby(game_id)
            if self._on_lobby_timeout:
                await self._on_lobby_timeout(game_id, "cancel")

    def _cleanup_lobby(self, game_id: str):
        """Remove a lobby."""
        lobby = self.lobbies.pop(game_id, None)
        if lobby:
            self.group_lobbies.pop(lobby.group_id, None)
            if lobby.timer_task and not lobby.timer_task.done():
                lobby.timer_task.cancel()

    def play_move(self, game_id: str, player_telegram_id: int, tile_dict: dict, side: str) -> dict:
        """
        Play a tile move.
        Returns the engine result dict.
        """
        session = self.sessions.get(game_id)
        if not session or not session.engine:
            return {"success": False, "error": "Game not found"}

        tile = Tile.from_dict(tile_dict)
        result = session.engine.play_tile(player_telegram_id, tile, side)
        return result

    def pass_move(self, game_id: str, player_telegram_id: int) -> dict:
        """Pass a turn."""
        session = self.sessions.get(game_id)
        if not session or not session.engine:
            return {"success": False, "error": "Game not found"}

        result = session.engine.pass_turn(player_telegram_id)
        return result

    def get_game_state(self, game_id: str, for_player_id: Optional[int] = None) -> Optional[dict]:
        """Get the current game state."""
        session = self.sessions.get(game_id)
        if not session or not session.engine:
            return None

        state = session.engine.state.to_dict(for_player_id=for_player_id)
        state["game_id"] = game_id
        state["session_id"] = session.session_id
        state["game_number"] = session.game_number
        state["total_games"] = GAMES_PER_SESSION
        return state

    def get_valid_moves(self, game_id: str, player_telegram_id: int) -> list[dict]:
        """Get valid moves for a player."""
        session = self.sessions.get(game_id)
        if not session or not session.engine:
            return []

        moves = session.engine.get_valid_moves(player_telegram_id)
        return [{"tile": m["tile"].to_dict(), "side": m["side"]} for m in moves]

    async def handle_game_over(self, game_id: str) -> dict:
        """
        Handle game end. Start next game in session or end session.
        Returns {"action": "next_game"|"session_end", ...}
        """
        session = self.sessions.get(game_id)
        if not session:
            return {"action": "error", "error": "Session not found"}

        engine = session.engine
        game_result = {
            "game_number": session.game_number,
            "winner_telegram_id": engine.state.winner_telegram_id,
            "is_fish": engine.state.is_fish,
        }
        session.results.append(game_result)

        if session.game_number < GAMES_PER_SESSION:
            # Start next game
            session.game_number += 1
            session.engine = DominoEngine(session.player_infos)
            return {
                "action": "next_game",
                "game_number": session.game_number,
                "game_result": game_result,
                "game_id": game_id,
            }
        else:
            # Session complete — include player_infos before cleanup
            result = {
                "action": "session_end",
                "results": session.results,
                "game_id": game_id,
                "group_id": session.group_id,
                "player_infos": session.player_infos,
            }
            # Cleanup
            self.group_sessions.pop(session.group_id, None)
            del self.sessions[game_id]
            return result

    def cancel_lobby(self, game_id: str) -> bool:
        """Cancel a lobby. Returns True if found and cancelled."""
        if game_id in self.lobbies:
            self._cleanup_lobby(game_id)
            return True
        return False

    def get_lobby(self, game_id: str) -> Optional[Lobby]:
        return self.lobbies.get(game_id)

    def get_session(self, game_id: str) -> Optional[ActiveSession]:
        return self.sessions.get(game_id)

    def get_group_game_id(self, group_id: int) -> Optional[str]:
        """Get the active game_id for a group (lobby or active)."""
        return self.group_lobbies.get(group_id) or self.group_sessions.get(group_id)

    def create_test_game(self, human_id: int, human_name: str, num_bots: int = 2) -> str:
        """
        Create a test game instantly with bot opponents. Skips the lobby entirely.
        Returns the game_id.
        """
        game_id = self._next_id()
        test_group_id = -abs(hash(game_id))  # Fake group ID

        player_infos = [
            {"telegram_id": human_id, "display_name": human_name},
        ]

        bot_names = ["Bot Alice", "Bot Bob", "Bot Charlie", "Bot Diana"]
        for i in range(num_bots):
            player_infos.append({
                "telegram_id": -(i + 1),  # Negative IDs for bots
                "display_name": bot_names[i],
            })

        engine = DominoEngine(player_infos)

        session = ActiveSession(
            session_id=game_id,
            group_id=test_group_id,
            game_id=game_id,
            game_number=1,
            player_infos=player_infos,
            engine=engine,
        )

        self.sessions[game_id] = session
        self.group_sessions[test_group_id] = game_id

        logger.info(f"Test game created: {game_id} with {len(player_infos)} players")
        return game_id


# Singleton instance
game_manager = GameManager()
