"""
Pure domino game logic. No I/O, no async — just game rules.
Standard double-six set (28 tiles).
"""

import random
from dataclasses import dataclass, field
from typing import Optional
from bot.config import TILES_PER_PLAYER


@dataclass(frozen=True)
class Tile:
    left: int
    right: int

    def __eq__(self, other):
        if not isinstance(other, Tile):
            return False
        return (self.left == other.left and self.right == other.right) or \
               (self.left == other.right and self.right == other.left)

    def __hash__(self):
        return hash((min(self.left, self.right), max(self.left, self.right)))

    def has_value(self, value: int) -> bool:
        return self.left == value or self.right == value

    def is_double(self) -> bool:
        return self.left == self.right

    def to_dict(self) -> dict:
        return {"left": self.left, "right": self.right}

    @staticmethod
    def from_dict(d: dict) -> "Tile":
        return Tile(left=d["left"], right=d["right"])

    def __repr__(self):
        return f"[{self.left}|{self.right}]"


def create_full_set() -> list[Tile]:
    """Create a standard double-six domino set (28 tiles)."""
    tiles = []
    for i in range(7):
        for j in range(i, 7):
            tiles.append(Tile(left=i, right=j))
    return tiles


@dataclass
class PlayerState:
    telegram_id: int
    display_name: str
    hand: list[Tile] = field(default_factory=list)
    passed_last_turn: bool = False

    def tile_count(self) -> int:
        return len(self.hand)

    def has_playable_tile(self, left_end: int, right_end: int) -> bool:
        """Check if the player has any tile that can be played."""
        for tile in self.hand:
            if tile.has_value(left_end) or tile.has_value(right_end):
                return True
        return False

    def remove_tile(self, tile: Tile) -> bool:
        """Remove a tile from hand. Returns True if found and removed."""
        for i, t in enumerate(self.hand):
            if t == tile:
                self.hand.pop(i)
                return True
        return False


@dataclass
class BoardTile:
    """A tile placed on the board with its orientation."""
    tile: Tile
    # The value exposed on the left side of this placed tile
    exposed_left: int
    # The value exposed on the right side of this placed tile
    exposed_right: int

    def to_dict(self) -> dict:
        return {
            "tile": self.tile.to_dict(),
            "exposed_left": self.exposed_left,
            "exposed_right": self.exposed_right,
        }


@dataclass
class GameState:
    players: list[PlayerState]
    board: list[BoardTile] = field(default_factory=list)
    boneyard: list[Tile] = field(default_factory=list)
    current_player_index: int = 0
    status: str = "waiting"  # waiting, active, finished
    winner_telegram_id: Optional[int] = None
    is_fish: bool = False
    consecutive_passes: int = 0

    @property
    def current_player(self) -> PlayerState:
        return self.players[self.current_player_index]

    @property
    def left_end(self) -> Optional[int]:
        if not self.board:
            return None
        return self.board[0].exposed_left

    @property
    def right_end(self) -> Optional[int]:
        if not self.board:
            return None
        return self.board[-1].exposed_right

    def next_turn(self):
        """Advance to the next player."""
        self.current_player_index = (self.current_player_index + 1) % len(self.players)

    def to_dict(self, for_player_id: Optional[int] = None) -> dict:
        """Serialize game state. If for_player_id is given, only show that player's hand."""
        players_data = []
        for p in self.players:
            pd = {
                "telegram_id": p.telegram_id,
                "display_name": p.display_name,
                "tile_count": p.tile_count(),
                "passed_last_turn": p.passed_last_turn,
            }
            if for_player_id is not None and p.telegram_id == for_player_id:
                pd["hand"] = [t.to_dict() for t in p.hand]
            players_data.append(pd)

        return {
            "players": players_data,
            "board": [bt.to_dict() for bt in self.board],
            "current_player_index": self.current_player_index,
            "current_player_id": self.current_player.telegram_id,
            "left_end": self.left_end,
            "right_end": self.right_end,
            "status": self.status,
            "winner_telegram_id": self.winner_telegram_id,
            "is_fish": self.is_fish,
            "boneyard_count": len(self.boneyard),
        }


class DominoEngine:
    """Handles all game logic for a single domino game."""

    def __init__(self, player_infos: list[dict]):
        """
        Initialize a new game.
        player_infos: list of {"telegram_id": int, "display_name": str}
        """
        num_players = len(player_infos)
        if num_players < 3 or num_players > 5:
            raise ValueError(f"Need 3-5 players, got {num_players}")

        tiles_per_player = TILES_PER_PLAYER[num_players]

        # Create and shuffle tiles
        all_tiles = create_full_set()
        random.shuffle(all_tiles)

        # Create players and deal tiles
        players = []
        for i, info in enumerate(player_infos):
            hand = all_tiles[i * tiles_per_player:(i + 1) * tiles_per_player]
            players.append(PlayerState(
                telegram_id=info["telegram_id"],
                display_name=info["display_name"],
                hand=hand,
            ))

        # Leftover tiles go to the boneyard (shop)
        dealt_count = num_players * tiles_per_player
        boneyard = all_tiles[dealt_count:]

        self.state = GameState(players=players, boneyard=boneyard)
        self._determine_first_player()
        self.state.status = "active"

    def _determine_first_player(self):
        """
        The player with the lowest double goes first: [0|0], then [1|1], etc.
        If no one has a double, the player with the highest-pip tile goes first.
        The qualifying double is stored so get_valid_moves can enforce it as the only first move.
        """
        best_player_index = 0
        best_double = 7  # Sentinel above max (6)

        for i, player in enumerate(self.state.players):
            for tile in player.hand:
                if tile.is_double() and tile.left < best_double:
                    best_double = tile.left
                    best_player_index = i

        if best_double < 7:
            # Store the required first tile
            self._forced_first_tile = Tile(left=best_double, right=best_double)
        else:
            # No doubles — find highest pip total
            self._forced_first_tile = None
            best_total = -1
            for i, player in enumerate(self.state.players):
                for tile in player.hand:
                    total = tile.left + tile.right
                    if total > best_total:
                        best_total = total
                        best_player_index = i

        self.state.current_player_index = best_player_index

    def get_valid_moves(self, player_telegram_id: int) -> list[dict]:
        """
        Get all valid moves for a player.
        Returns list of {"tile": Tile, "side": "left"|"right"} dicts.
        For the first move, side is "left" (doesn't matter).
        """
        player = self._get_player(player_telegram_id)
        if not player:
            return []

        moves = []

        if not self.state.board:
            # First move — must play the qualifying double if one exists
            if self._forced_first_tile and self._forced_first_tile in player.hand:
                moves.append({"tile": self._forced_first_tile, "side": "left"})
            else:
                # No forced tile (no doubles existed) — any tile can be played
                for tile in player.hand:
                    moves.append({"tile": tile, "side": "left"})
            return moves

        left_end = self.state.left_end
        right_end = self.state.right_end

        for tile in player.hand:
            if tile.has_value(left_end):
                moves.append({"tile": tile, "side": "left"})
            if tile.has_value(right_end):
                # Avoid duplicate if tile matches both ends and both ends are same value
                if left_end != right_end or not tile.has_value(left_end):
                    moves.append({"tile": tile, "side": "right"})
                elif left_end == right_end and tile.has_value(left_end):
                    # Tile matches both ends (which are the same) — also offer right
                    moves.append({"tile": tile, "side": "right"})

        return moves

    def draw_tile(self, player_telegram_id: int) -> dict:
        """
        Draw one tile from the boneyard into the player's hand.
        Returns {"success": bool, "error": str|None, "tile": dict|None, "boneyard_count": int}
        """
        if self.state.status != "active":
            return {"success": False, "error": "Game is not active", "tile": None,
                    "boneyard_count": len(self.state.boneyard)}

        player = self._get_player(player_telegram_id)
        if not player:
            return {"success": False, "error": "Player not in game", "tile": None,
                    "boneyard_count": len(self.state.boneyard)}

        if player.telegram_id != self.state.current_player.telegram_id:
            return {"success": False, "error": "Not your turn", "tile": None,
                    "boneyard_count": len(self.state.boneyard)}

        if not self.state.boneyard:
            return {"success": False, "error": "Boneyard is empty", "tile": None,
                    "boneyard_count": 0}

        # Player must have no valid moves to draw
        if self.state.board:
            if player.has_playable_tile(self.state.left_end, self.state.right_end):
                return {"success": False, "error": "You have playable tiles, cannot draw",
                        "tile": None, "boneyard_count": len(self.state.boneyard)}

        drawn = self.state.boneyard.pop()
        player.hand.append(drawn)

        return {"success": True, "error": None, "tile": drawn.to_dict(),
                "boneyard_count": len(self.state.boneyard)}

    def play_tile(self, player_telegram_id: int, tile: Tile, side: str) -> dict:
        """
        Play a tile on the given side of the board.
        Returns {"success": bool, "error": str|None, "game_over": bool, "is_fish": bool}
        """
        if self.state.status != "active":
            return {"success": False, "error": "Game is not active", "game_over": False, "is_fish": False}

        player = self._get_player(player_telegram_id)
        if not player:
            return {"success": False, "error": "Player not in game", "game_over": False, "is_fish": False}

        if player.telegram_id != self.state.current_player.telegram_id:
            return {"success": False, "error": "Not your turn", "game_over": False, "is_fish": False}

        # Check player has this tile
        if tile not in player.hand:
            return {"success": False, "error": "You don't have this tile", "game_over": False, "is_fish": False}

        # First tile on empty board
        if not self.state.board:
            board_tile = BoardTile(
                tile=tile,
                exposed_left=tile.left,
                exposed_right=tile.right,
            )
            self.state.board.append(board_tile)
            player.remove_tile(tile)
            player.passed_last_turn = False
            self.state.consecutive_passes = 0
            return self._after_play(player)

        # Validate the move
        if side == "left":
            target_value = self.state.left_end
        elif side == "right":
            target_value = self.state.right_end
        else:
            return {"success": False, "error": "Invalid side", "game_over": False, "is_fish": False}

        if not tile.has_value(target_value):
            return {"success": False, "error": f"Tile {tile} doesn't match {side} end ({target_value})", "game_over": False, "is_fish": False}

        # Place the tile
        if side == "left":
            # The tile's matching value connects to the board's left end
            if tile.right == target_value:
                board_tile = BoardTile(tile=tile, exposed_left=tile.left, exposed_right=tile.right)
            else:
                board_tile = BoardTile(tile=tile, exposed_left=tile.right, exposed_right=tile.left)
            self.state.board.insert(0, board_tile)
        else:  # right
            if tile.left == target_value:
                board_tile = BoardTile(tile=tile, exposed_left=tile.left, exposed_right=tile.right)
            else:
                board_tile = BoardTile(tile=tile, exposed_left=tile.right, exposed_right=tile.left)
            self.state.board.append(board_tile)

        player.remove_tile(tile)
        player.passed_last_turn = False
        self.state.consecutive_passes = 0
        return self._after_play(player)

    def pass_turn(self, player_telegram_id: int) -> dict:
        """
        Pass the turn (when player has no valid moves).
        Returns same dict as play_tile.
        """
        if self.state.status != "active":
            return {"success": False, "error": "Game is not active", "game_over": False, "is_fish": False}

        player = self._get_player(player_telegram_id)
        if not player:
            return {"success": False, "error": "Player not in game", "game_over": False, "is_fish": False}

        if player.telegram_id != self.state.current_player.telegram_id:
            return {"success": False, "error": "Not your turn", "game_over": False, "is_fish": False}

        # Check that the player truly has no valid moves
        if self.state.board:
            if player.has_playable_tile(self.state.left_end, self.state.right_end):
                return {"success": False, "error": "You have playable tiles, cannot pass", "game_over": False, "is_fish": False}

        # Cannot pass if boneyard still has tiles — must draw instead
        if self.state.boneyard:
            return {"success": False, "error": "Boneyard is not empty, draw a tile first", "game_over": False, "is_fish": False}

        player.passed_last_turn = True
        self.state.consecutive_passes += 1

        # Check for fish: all players passed in a row
        if self.state.consecutive_passes >= len(self.state.players):
            self.state.status = "finished"
            self.state.is_fish = True
            self.state.winner_telegram_id = None
            return {"success": True, "error": None, "game_over": True, "is_fish": True}

        self.state.next_turn()
        # Auto-skip players who also can't play
        self._auto_skip_blocked_players()

        return {"success": True, "error": None, "game_over": self.state.status == "finished",
                "is_fish": self.state.is_fish}

    def _after_play(self, player: PlayerState) -> dict:
        """Check win condition and advance turn after a successful play."""
        if player.tile_count() == 0:
            self.state.status = "finished"
            self.state.winner_telegram_id = player.telegram_id
            return {"success": True, "error": None, "game_over": True, "is_fish": False}

        self.state.next_turn()
        # Auto-skip players who can't play
        self._auto_skip_blocked_players()

        return {"success": True, "error": None, "game_over": self.state.status == "finished",
                "is_fish": self.state.is_fish}

    def _auto_skip_blocked_players(self):
        """
        Auto-pass players who have no valid moves AND cannot draw from the boneyard.
        If all players are blocked (and boneyard is empty), it's a fish.
        When boneyard has tiles, stop at the first blocked player so they can draw.
        """
        if self.state.status != "active":
            return

        checked = 0
        while checked < len(self.state.players):
            current = self.state.current_player
            if current.has_playable_tile(self.state.left_end, self.state.right_end):
                return  # This player can play

            # If boneyard has tiles, stop here — player must draw manually (or bot AI draws)
            if self.state.boneyard:
                return

            current.passed_last_turn = True
            self.state.consecutive_passes += 1

            if self.state.consecutive_passes >= len(self.state.players):
                # Fish!
                self.state.status = "finished"
                self.state.is_fish = True
                self.state.winner_telegram_id = None
                return

            self.state.next_turn()
            checked += 1

    def _get_player(self, telegram_id: int) -> Optional[PlayerState]:
        for p in self.state.players:
            if p.telegram_id == telegram_id:
                return p
        return None
