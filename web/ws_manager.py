"""
WebSocket connection manager for real-time game updates.
"""

import json
import logging
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WSManager:
    """Manages WebSocket connections per game."""

    def __init__(self):
        # game_id -> {player_telegram_id -> WebSocket}
        self.connections: dict[str, dict[int, WebSocket]] = {}

    async def connect(self, game_id: str, player_id: int, ws: WebSocket):
        """Register a WebSocket connection for a player in a game."""
        await ws.accept()
        if game_id not in self.connections:
            self.connections[game_id] = {}
        self.connections[game_id][player_id] = ws
        logger.info(f"WS connected: game={game_id}, player={player_id}")

    def disconnect(self, game_id: str, player_id: int):
        """Remove a WebSocket connection."""
        if game_id in self.connections:
            self.connections[game_id].pop(player_id, None)
            if not self.connections[game_id]:
                del self.connections[game_id]
        logger.info(f"WS disconnected: game={game_id}, player={player_id}")

    async def send_personal(self, game_id: str, player_id: int, data: dict):
        """Send a message to a specific player."""
        ws = self.connections.get(game_id, {}).get(player_id)
        if ws:
            try:
                await ws.send_text(json.dumps(data))
            except Exception as e:
                logger.error(f"WS send error to {player_id}: {e}")
                self.disconnect(game_id, player_id)

    async def broadcast_game_state(self, game_id: str, game_state_fn):
        """
        Broadcast personalized game state to all connected players.
        game_state_fn(player_id) -> dict
        """
        conns = self.connections.get(game_id, {})
        for player_id, ws in list(conns.items()):
            try:
                state = game_state_fn(player_id)
                if state:
                    await ws.send_text(json.dumps({
                        "type": "game_state",
                        "data": state,
                    }))
            except Exception as e:
                logger.error(f"WS broadcast error to {player_id}: {e}")
                self.disconnect(game_id, player_id)

    async def broadcast_event(self, game_id: str, event_type: str, data: dict):
        """Broadcast the same event to all players in a game."""
        conns = self.connections.get(game_id, {})
        message = json.dumps({"type": event_type, "data": data})
        for player_id, ws in list(conns.items()):
            try:
                await ws.send_text(message)
            except Exception as e:
                logger.error(f"WS event broadcast error to {player_id}: {e}")
                self.disconnect(game_id, player_id)

    def cleanup_game(self, game_id: str):
        """Remove all connections for a game."""
        self.connections.pop(game_id, None)


# Singleton
ws_manager = WSManager()
