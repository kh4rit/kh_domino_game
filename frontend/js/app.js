/**
 * Main application logic — ties together Telegram SDK, WebSocket, and Game rendering.
 */
const App = {
    gameId: null,
    playerId: null,
    apiHeaders: {},
    passPending: false,

    async init() {
        // Initialize Telegram SDK and sound first (needed for start_param)
        TG.init();
        SFX.init();

        // Get URL params to check for test mode
        const params = new URLSearchParams(window.location.search);
        const isTestMode = params.get('test') === '1';
        const testPlayerId = params.get('player_id');

        // Get game_id from URL params, or from Telegram start_param (deep link)
        this.gameId = params.get('game_id');
        if (!this.gameId && TG.webapp) {
            this.gameId = TG.webapp.initDataUnsafe?.start_param || null;
        }

        // In test mode, override player ID from URL
        if (isTestMode && testPlayerId) {
            this.playerId = parseInt(testPlayerId);
            TG.user = { id: this.playerId, first_name: 'Test', last_name: 'Player' };
        } else {
            this.playerId = TG.getPlayerId();
        }

        Game.setPlayerId(this.playerId);

        if (!this.gameId) {
            this.showError('No game ID provided.');
            return;
        }

        // Set up API headers
        this.apiHeaders = {
            'Content-Type': 'application/json',
        };
        if (!isTestMode && TG.initData) {
            this.apiHeaders['X-Telegram-Init-Data'] = TG.initData;
        } else {
            this.apiHeaders['X-Player-Id'] = String(this.playerId);
        }

        // Connect WebSocket
        WS.onMessage = (msg) => this.handleWSMessage(msg);
        WS.connect(this.gameId, this.playerId);

        // Fetch initial state
        await this.fetchGameState();

        // Show game screen
        this.showScreen('screen-game');
    },

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const screen = document.getElementById(screenId);
        if (screen) screen.classList.add('active');
    },

    showError(message) {
        const loading = document.getElementById('screen-loading');
        loading.querySelector('p').textContent = message;
        loading.querySelector('.loading-spinner').style.display = 'none';
    },

    /**
     * Fetch game state from REST API and render.
     */
    async fetchGameState() {
        try {
            const resp = await fetch(`/api/game/${this.gameId}`, {
                headers: this.apiHeaders,
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }

            const state = await resp.json();

            // Also fetch valid moves
            await this.fetchValidMoves();

            Game.render(state);
        } catch (e) {
            console.error('Failed to fetch game state:', e);
            this.showError('Failed to load game. Please try again.');
        }
    },

    /**
     * Fetch valid moves for the current player.
     */
    async fetchValidMoves() {
        try {
            const resp = await fetch(`/api/game/${this.gameId}/moves`, {
                headers: this.apiHeaders,
            });

            if (resp.ok) {
                const data = await resp.json();
                Game.validMoves = data.moves || [];
            }
        } catch (e) {
            console.error('Failed to fetch valid moves:', e);
            Game.validMoves = [];
        }
    },

    /**
     * Play a tile move.
     */
    async playMove(tile, side) {
        try {
            const resp = await fetch(`/api/game/${this.gameId}/move`, {
                method: 'POST',
                headers: this.apiHeaders,
                body: JSON.stringify({ tile, side }),
            });

            const result = await resp.json();

            if (!result.success) {
                console.error('Move failed:', result.error);
                TG.hapticFeedback('error');
                SFX.error();
                // Re-render to reset UI
                if (Game.state) {
                    await this.fetchValidMoves();
                    Game.render(Game.state);
                }
            } else {
                SFX.tilePlaced();
            }
            // If success, the WebSocket will send us the updated state

        } catch (e) {
            console.error('Play move error:', e);
            TG.hapticFeedback('error');
        }
    },

    /**
     * Draw a tile from the boneyard (shop).
     */
    async drawTile() {
        try {
            const resp = await fetch(`/api/game/${this.gameId}/draw`, {
                method: 'POST',
                headers: this.apiHeaders,
            });

            const result = await resp.json();

            if (result.success) {
                TG.hapticFeedback('light');
                SFX.draw();
                // WebSocket will send us updated state; also re-fetch moves
                // since the drawn tile might be playable
            } else {
                console.error('Draw failed:', result.error);
                TG.hapticFeedback('error');
                SFX.error();
            }
        } catch (e) {
            console.error('Draw tile error:', e);
            TG.hapticFeedback('error');
        }
    },

    /**
     * Auto-pass when no moves are available.
     */
    async autoPass() {
        if (this.passPending) return;
        this.passPending = true;

        try {
            const resp = await fetch(`/api/game/${this.gameId}/pass`, {
                method: 'POST',
                headers: this.apiHeaders,
            });

            const result = await resp.json();
            if (!result.success) {
                console.error('Pass failed:', result.error);
            } else {
                SFX.pass();
            }
        } catch (e) {
            console.error('Auto-pass error:', e);
        } finally {
            this.passPending = false;
        }
    },

    /**
     * Handle incoming WebSocket messages.
     */
    handleWSMessage(msg) {
        console.log('WS message:', msg.type);

        switch (msg.type) {
            case 'game_state':
                this.onGameStateUpdate(msg.data);
                break;

            case 'game_over':
                Game.showGameOver(msg.data);
                break;

            case 'session_end':
                Game.showSessionEnd(msg.data);
                break;

            default:
                console.log('Unknown WS message type:', msg.type);
        }
    },

    /**
     * Handle game state update from WebSocket.
     */
    async onGameStateUpdate(state) {
        const wasMyTurn = Game.state && Game.state.current_player_id === this.playerId;
        const isMyTurn = state.current_player_id === this.playerId && state.status === 'active';

        // Fetch valid moves for the new state
        Game.validMoves = [];
        if (isMyTurn) {
            await this.fetchValidMoves();
        }

        // Play "your turn" sound when turn switches to us
        if (isMyTurn && !wasMyTurn) {
            SFX.yourTurn();
        }

        // Hide game over overlay if a new game started
        const overlay = document.getElementById('overlay-gameover');
        if (state.status === 'active' && !overlay.classList.contains('hidden')) {
            overlay.classList.add('hidden');
        }

        Game.render(state);
    },
};

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
