/**
 * Game board and tile rendering + interaction logic.
 */
const Game = {
    state: null,
    selectedTile: null,
    validMoves: [],
    playerId: 0,

    /** Pip layout positions for values 0-6 in a 3x3 grid */
    PIP_LAYOUTS: {
        0: [],
        1: ['mc'],
        2: ['tl', 'br'],
        3: ['tl', 'mc', 'br'],
        4: ['tl', 'tr', 'bl', 'br'],
        5: ['tl', 'tr', 'mc', 'bl', 'br'],
        6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br'],
    },

    setPlayerId(id) {
        this.playerId = id;
    },

    /**
     * Create a DOM element for a domino tile half (one side with pips).
     */
    createHalfElement(value) {
        const half = document.createElement('div');
        half.className = 'tile-half';

        const positions = this.PIP_LAYOUTS[value] || [];
        for (const pos of positions) {
            const pip = document.createElement('div');
            pip.className = `pip pos-${pos}`;
            half.appendChild(pip);
        }

        return half;
    },

    /**
     * Create a full domino tile element.
     * @param {object} tile - {left, right}
     * @param {string} orientation - 'horizontal' or 'vertical'
     * @param {object} options - {clickable, selected, playable, boardTile}
     */
    createTileElement(tile, orientation = 'vertical', options = {}) {
        const el = document.createElement('div');
        el.className = `domino-tile ${orientation}`;
        el.dataset.left = tile.left;
        el.dataset.right = tile.right;

        if (options.selected) el.classList.add('selected');
        if (options.playable) el.classList.add('playable');
        if (options.playable === false && !options.boardTile) el.classList.add('not-playable');

        const firstValue = orientation === 'horizontal'
            ? (options.exposedLeft !== undefined ? options.exposedLeft : tile.left)
            : tile.left;
        const secondValue = orientation === 'horizontal'
            ? (options.exposedRight !== undefined ? options.exposedRight : tile.right)
            : tile.right;

        el.appendChild(this.createHalfElement(firstValue));
        el.appendChild(this.createHalfElement(secondValue));

        if (options.clickable && options.onClick) {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                TG.hapticFeedback('light');
                el.classList.add('tap-feedback');
                setTimeout(() => el.classList.remove('tap-feedback'), 150);
                options.onClick(tile);
            });
        }

        return el;
    },

    /**
     * Render the game board.
     */
    renderBoard(state) {
        const boardEl = document.getElementById('board');
        boardEl.innerHTML = '';

        if (!state.board || state.board.length === 0) {
            boardEl.classList.add('empty');
            return;
        }

        boardEl.classList.remove('empty');

        // Render each tile on the board horizontally
        for (const bt of state.board) {
            const tileEl = this.createTileElement(bt.tile, 'horizontal', {
                boardTile: true,
                exposedLeft: bt.exposed_left,
                exposedRight: bt.exposed_right,
            });
            boardEl.appendChild(tileEl);
        }

        // Auto-scroll to center
        const container = document.getElementById('board-container');
        requestAnimationFrame(() => {
            const scrollLeft = (boardEl.scrollWidth - container.clientWidth) / 2;
            container.scrollLeft = Math.max(0, scrollLeft);
        });
    },

    /**
     * Render the player's hand.
     */
    renderHand(state) {
        const handEl = document.getElementById('hand');
        handEl.innerHTML = '';

        const myPlayer = state.players.find(p => p.telegram_id === this.playerId);
        if (!myPlayer || !myPlayer.hand) return;

        const isMyTurn = state.current_player_id === this.playerId && state.status === 'active';

        // Calculate which tiles are playable
        const playableTiles = new Set();
        if (isMyTurn) {
            for (const move of this.validMoves) {
                const key = `${move.tile.left},${move.tile.right}`;
                playableTiles.add(key);
            }
        }

        // Adjust tile size if many tiles
        if (myPlayer.hand.length > 6) {
            handEl.classList.add('many-tiles');
        } else {
            handEl.classList.remove('many-tiles');
        }

        for (const tile of myPlayer.hand) {
            const key = `${tile.left},${tile.right}`;
            const reverseKey = `${tile.right},${tile.left}`;
            const isPlayable = playableTiles.has(key) || playableTiles.has(reverseKey);
            const isSelected = this.selectedTile &&
                ((this.selectedTile.left === tile.left && this.selectedTile.right === tile.right) ||
                 (this.selectedTile.left === tile.right && this.selectedTile.right === tile.left));

            const tileEl = this.createTileElement(tile, 'vertical', {
                clickable: isMyTurn && isPlayable,
                playable: isMyTurn ? isPlayable : undefined,
                selected: isSelected,
                onClick: (t) => this.onTileClick(t),
            });

            handEl.appendChild(tileEl);
        }
    },

    /**
     * Render the opponents bar.
     */
    renderOpponents(state) {
        const bar = document.getElementById('opponents-bar');
        bar.innerHTML = '';

        for (const player of state.players) {
            if (player.telegram_id === this.playerId) continue;

            const div = document.createElement('div');
            div.className = 'opponent';

            if (state.current_player_id === player.telegram_id && state.status === 'active') {
                div.classList.add('active-turn');
            }
            if (player.passed_last_turn) {
                div.classList.add('passed');
            }

            div.innerHTML = `
                <span class="name">${this.escapeHtml(player.display_name)}</span>
                <span class="tile-count">${player.tile_count}</span>
            `;

            bar.appendChild(div);
        }
    },

    /**
     * Render the turn indicator.
     */
    renderTurnIndicator(state) {
        const indicator = document.getElementById('turn-indicator');
        const text = document.getElementById('turn-text');

        if (state.status !== 'active') {
            text.textContent = '';
            indicator.classList.remove('my-turn');
            return;
        }

        const isMyTurn = state.current_player_id === this.playerId;

        if (isMyTurn) {
            const hasPlayableTiles = this.validMoves.length > 0;
            if (hasPlayableTiles) {
                text.textContent = 'Your turn — tap a tile to play';
            } else {
                text.textContent = 'No playable tiles — passing...';
            }
            indicator.classList.add('my-turn');
        } else {
            const currentPlayer = state.players.find(p => p.telegram_id === state.current_player_id);
            const name = currentPlayer ? currentPlayer.display_name : 'Opponent';
            text.textContent = `${name}'s turn...`;
            indicator.classList.remove('my-turn');
        }
    },

    /**
     * Update session info.
     */
    renderSessionInfo(state) {
        document.getElementById('game-number').textContent = state.game_number || '1';
        document.getElementById('total-games').textContent = state.total_games || '2';
    },

    /**
     * Full render of the game state.
     */
    render(state) {
        this.state = state;
        this.renderBoard(state);
        this.renderHand(state);
        this.renderOpponents(state);
        this.renderTurnIndicator(state);
        this.renderSessionInfo(state);

        // Auto-pass if it's our turn but no moves
        if (state.status === 'active' &&
            state.current_player_id === this.playerId &&
            this.validMoves.length === 0 &&
            state.board && state.board.length > 0) {
            setTimeout(() => App.autoPass(), 500);
        }
    },

    /**
     * Handle tile click in hand.
     */
    onTileClick(tile) {
        if (this.selectedTile &&
            this.selectedTile.left === tile.left &&
            this.selectedTile.right === tile.right) {
            // Deselect
            this.selectedTile = null;
            this.renderHand(this.state);
            return;
        }

        this.selectedTile = tile;

        // Find which sides this tile can be placed on
        const possibleSides = [];
        for (const move of this.validMoves) {
            if ((move.tile.left === tile.left && move.tile.right === tile.right) ||
                (move.tile.left === tile.right && move.tile.right === tile.left)) {
                possibleSides.push(move.side);
            }
        }

        if (possibleSides.length === 0) return;

        // If the board is empty, just play (no side choice needed)
        if (!this.state.board || this.state.board.length === 0) {
            App.playMove(tile, 'left');
            this.selectedTile = null;
            return;
        }

        if (possibleSides.length === 1) {
            // Only one side possible — play immediately
            App.playMove(tile, possibleSides[0]);
            this.selectedTile = null;
        } else {
            // Both sides possible — show side selector
            this.renderHand(this.state);
            this.showSideSelector(tile);
        }
    },

    /**
     * Show the side selector dialog.
     */
    showSideSelector(tile) {
        const selector = document.getElementById('side-selector');
        selector.classList.remove('hidden');

        const btnLeft = document.getElementById('btn-left');
        const btnRight = document.getElementById('btn-right');
        const btnCancel = document.getElementById('btn-cancel-side');

        // Add end values to buttons for clarity
        if (this.state) {
            btnLeft.textContent = `Left (${this.state.left_end})`;
            btnRight.textContent = `Right (${this.state.right_end})`;
        }

        const cleanup = () => {
            selector.classList.add('hidden');
            btnLeft.onclick = null;
            btnRight.onclick = null;
            btnCancel.onclick = null;
        };

        btnLeft.onclick = () => {
            TG.hapticFeedback('medium');
            cleanup();
            App.playMove(tile, 'left');
            this.selectedTile = null;
        };

        btnRight.onclick = () => {
            TG.hapticFeedback('medium');
            cleanup();
            App.playMove(tile, 'right');
            this.selectedTile = null;
        };

        btnCancel.onclick = () => {
            cleanup();
            this.selectedTile = null;
            this.renderHand(this.state);
        };
    },

    /**
     * Show game over overlay.
     */
    showGameOver(data) {
        const overlay = document.getElementById('overlay-gameover');
        const title = document.getElementById('gameover-title');
        const message = document.getElementById('gameover-message');
        const nextDiv = document.getElementById('gameover-next');
        const sessionEndDiv = document.getElementById('gameover-session-end');

        overlay.classList.remove('hidden');
        nextDiv.classList.add('hidden');
        sessionEndDiv.classList.add('hidden');

        const result = data.game_result || data;

        if (result.is_fish) {
            title.textContent = 'Fish!';
            title.className = 'fish';
            message.textContent = 'Nobody could play — the fish wins this one!';
            TG.hapticFeedback('warning');
        } else if (result.winner_telegram_id === this.playerId) {
            title.textContent = 'You Win!';
            title.className = 'win';
            message.textContent = 'Congratulations!';
            TG.hapticFeedback('success');
        } else {
            const winner = this.state?.players?.find(p => p.telegram_id === result.winner_telegram_id);
            const name = winner ? winner.display_name : 'Someone';
            title.textContent = `${name} Wins!`;
            title.className = 'lose';
            message.textContent = 'Better luck next time!';
            TG.hapticFeedback('error');
        }

        if (data.next_game) {
            nextDiv.classList.remove('hidden');
            // Auto-hide after state update
            setTimeout(() => {
                overlay.classList.add('hidden');
            }, 3000);
        }
    },

    /**
     * Show session end overlay.
     */
    showSessionEnd(data) {
        const overlay = document.getElementById('overlay-gameover');
        const title = document.getElementById('gameover-title');
        const message = document.getElementById('gameover-message');
        const nextDiv = document.getElementById('gameover-next');
        const sessionEndDiv = document.getElementById('gameover-session-end');
        const resultsDiv = document.getElementById('session-results');

        overlay.classList.remove('hidden');
        nextDiv.classList.add('hidden');
        sessionEndDiv.classList.remove('hidden');

        title.textContent = 'Session Complete!';
        title.className = '';
        message.textContent = '';

        resultsDiv.innerHTML = '';
        for (const r of data.results) {
            const row = document.createElement('div');
            row.className = 'result-row';

            let winnerText = '';
            let winnerClass = '';

            if (r.is_fish) {
                winnerText = 'Fish!';
                winnerClass = 'fish';
            } else if (r.winner_telegram_id) {
                const winner = this.state?.players?.find(p => p.telegram_id === r.winner_telegram_id);
                winnerText = winner ? winner.display_name : 'Unknown';
                winnerClass = r.winner_telegram_id === this.playerId ? 'winner' : '';
            }

            row.innerHTML = `
                <span class="result-label">Game ${r.game_number}</span>
                <span class="result-value ${winnerClass}">${this.escapeHtml(winnerText)}</span>
            `;
            resultsDiv.appendChild(row);
        }

        document.getElementById('btn-close').onclick = () => {
            const params = new URLSearchParams(window.location.search);
            if (params.get('test') === '1') {
                window.location.href = '/test';
            } else {
                TG.close();
            }
        };
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
