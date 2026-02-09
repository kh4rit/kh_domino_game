/**
 * Game board and tile rendering + interaction logic.
 */
const Game = {
    state: null,
    selectedTile: null,
    validMoves: [],
    playerId: 0,
    _timerInterval: null,
    _dragState: null,  // {tile, startX, startY, isDragging, ghost, sides}
    DRAG_THRESHOLD: 10,

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
                clickable: false,  // We handle click via drag threshold
                playable: isMyTurn ? isPlayable : undefined,
                selected: isSelected,
            });

            // Attach unified pointer handlers for drag + click
            if (isMyTurn && isPlayable) {
                this._attachDragHandlers(tileEl, tile);
            }

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
     * Render the turn indicator, Draw button, boneyard count, and turn timer.
     */
    renderTurnIndicator(state) {
        const indicator = document.getElementById('turn-indicator');
        const text = document.getElementById('turn-text');
        const drawBtn = document.getElementById('btn-draw');
        const boneyardEl = document.getElementById('boneyard-count');
        const timerEl = document.getElementById('turn-timer');

        // Reset draw button
        drawBtn.classList.add('hidden');
        drawBtn.onclick = null;

        // Stop existing timer interval
        this._stopTimerInterval();

        // Show boneyard count when > 0
        if (state.boneyard_count > 0) {
            boneyardEl.textContent = `Shop: ${state.boneyard_count}`;
            boneyardEl.classList.remove('hidden');
        } else {
            boneyardEl.classList.add('hidden');
        }

        if (state.status !== 'active') {
            text.textContent = '';
            timerEl.classList.add('hidden');
            indicator.classList.remove('my-turn');
            return;
        }

        const isMyTurn = state.current_player_id === this.playerId;

        if (isMyTurn) {
            const hasPlayableTiles = this.validMoves.length > 0;
            if (hasPlayableTiles) {
                text.textContent = 'Your turn — tap a tile to play';
            } else if (state.boneyard_count > 0) {
                text.textContent = 'No playable tiles — draw from the shop!';
                drawBtn.classList.remove('hidden');
                drawBtn.onclick = () => {
                    TG.hapticFeedback('light');
                    App.drawTile();
                };
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

        // Start countdown timer if turn_deadline is set
        if (state.turn_deadline) {
            timerEl.classList.remove('hidden');
            this._startTimerInterval(state.turn_deadline, timerEl);
        } else {
            timerEl.classList.add('hidden');
        }
    },

    /** Start the turn countdown interval. */
    _startTimerInterval(deadline, timerEl) {
        let lastRemaining = -1;
        const isMyTurn = this.state && this.state.current_player_id === this.playerId;

        const update = () => {
            const remaining = Math.max(0, Math.ceil(deadline - Date.now() / 1000));
            timerEl.textContent = `${remaining}s`;
            timerEl.classList.toggle('timer-warning', remaining <= 5);

            // Play warning tick each second in the danger zone (only for the active player)
            if (isMyTurn && remaining <= 5 && remaining > 0 && remaining !== lastRemaining) {
                SFX.timerWarning();
            }
            lastRemaining = remaining;

            if (remaining <= 0) {
                this._stopTimerInterval();
            }
        };
        update();
        this._timerInterval = setInterval(update, 500);
    },

    /** Stop the turn countdown interval. */
    _stopTimerInterval() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
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

        // Auto-pass if it's our turn but no moves AND boneyard is empty
        if (state.status === 'active' &&
            state.current_player_id === this.playerId &&
            this.validMoves.length === 0 &&
            state.board && state.board.length > 0 &&
            (state.boneyard_count || 0) === 0) {
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
            SFX.fish();
        } else if (result.winner_telegram_id === this.playerId) {
            title.textContent = 'You Win!';
            title.className = 'win';
            message.textContent = 'Congratulations!';
            TG.hapticFeedback('success');
            SFX.gameWin();
        } else {
            const winner = this.state?.players?.find(p => p.telegram_id === result.winner_telegram_id);
            const name = winner ? winner.display_name : 'Someone';
            title.textContent = `${name} Wins!`;
            title.className = 'lose';
            message.textContent = 'Better luck next time!';
            TG.hapticFeedback('error');
            SFX.gameLose();
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

    // --- Drag and Drop ---

    /** Get possible sides for a tile. */
    _getPossibleSides(tile) {
        const sides = [];
        for (const move of this.validMoves) {
            if ((move.tile.left === tile.left && move.tile.right === tile.right) ||
                (move.tile.left === tile.right && move.tile.right === tile.left)) {
                sides.push(move.side);
            }
        }
        return sides;
    },

    /** Attach touch + mouse drag handlers to a tile element. */
    _attachDragHandlers(el, tile) {
        // Touch events
        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            this._onDragStart(tile, touch.clientX, touch.clientY, el);
        }, { passive: true });

        el.addEventListener('touchmove', (e) => {
            if (!this._dragState) return;
            const touch = e.touches[0];
            this._onDragMove(touch.clientX, touch.clientY);
            if (this._dragState.isDragging) {
                e.preventDefault();
            }
        }, { passive: false });

        el.addEventListener('touchend', (e) => {
            if (!this._dragState) return;
            const touch = e.changedTouches[0];
            this._onDragEnd(touch.clientX, touch.clientY);
        });

        // Mouse events
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            this._onDragStart(tile, e.clientX, e.clientY, el);

            const onMouseMove = (ev) => {
                if (!this._dragState) return;
                this._onDragMove(ev.clientX, ev.clientY);
            };
            const onMouseUp = (ev) => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (!this._dragState) return;
                this._onDragEnd(ev.clientX, ev.clientY);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    },

    /** Begin a potential drag. */
    _onDragStart(tile, x, y, el) {
        const sides = this._getPossibleSides(tile);
        this._dragState = {
            tile,
            startX: x,
            startY: y,
            isDragging: false,
            ghost: null,
            sides,
            sourceEl: el,
        };
    },

    /** Handle move — start actual drag if threshold exceeded. */
    _onDragMove(x, y) {
        const ds = this._dragState;
        if (!ds) return;

        const dx = x - ds.startX;
        const dy = y - ds.startY;

        if (!ds.isDragging) {
            if (Math.abs(dx) > this.DRAG_THRESHOLD || Math.abs(dy) > this.DRAG_THRESHOLD) {
                ds.isDragging = true;
                ds.sourceEl.classList.add('dragging');
                this._createGhost(ds.tile, x, y);
                this._showDropMarkers(ds.tile, ds.sides);
            }
            return;
        }

        // Move ghost
        if (ds.ghost) {
            ds.ghost.style.left = `${x}px`;
            ds.ghost.style.top = `${y}px`;
        }

        // Highlight nearest drop target
        this._updateDropHighlight(x, y);
    },

    /** Handle end — either drop on a marker or treat as click. */
    _onDragEnd(x, y) {
        const ds = this._dragState;
        if (!ds) return;

        if (ds.isDragging) {
            const side = this._getDropTarget(x, y);
            this._cleanupDrag();

            if (side) {
                TG.hapticFeedback('medium');
                App.playMove(ds.tile, side);
            }
        } else {
            // Was a tap/click (below threshold)
            this._cleanupDrag();
            TG.hapticFeedback('light');
            this.onTileClick(ds.tile);
        }

        this._dragState = null;
    },

    /** Create a floating ghost tile that follows the pointer. */
    _createGhost(tile, x, y) {
        const ghost = this.createTileElement(tile, 'vertical', { playable: true });
        ghost.classList.add('drag-ghost');
        ghost.style.left = `${x}px`;
        ghost.style.top = `${y}px`;
        document.body.appendChild(ghost);
        this._dragState.ghost = ghost;
    },

    /** Show left/right drop markers on the board. */
    _showDropMarkers(tile, sides) {
        this._removeDropMarkers();

        const boardEl = document.getElementById('board');
        if (!this.state || !this.state.board || this.state.board.length === 0) {
            // Empty board — single center marker
            if (sides.includes('left')) {
                const marker = this._createMarker('left', 'Play here');
                boardEl.appendChild(marker);
            }
            return;
        }

        if (sides.includes('left')) {
            const marker = this._createMarker('left', `\u25C0 ${this.state.left_end}`);
            boardEl.insertBefore(marker, boardEl.firstChild);
        }
        if (sides.includes('right')) {
            const marker = this._createMarker('right', `${this.state.right_end} \u25B6`);
            boardEl.appendChild(marker);
        }
    },

    /** Create a drop marker element. */
    _createMarker(side, label) {
        const marker = document.createElement('div');
        marker.className = 'board-end-marker drop-target';
        marker.dataset.side = side;
        marker.textContent = label;
        return marker;
    },

    /** Remove all drop markers. */
    _removeDropMarkers() {
        document.querySelectorAll('.drop-target').forEach(el => el.remove());
    },

    /** Highlight the nearest drop target based on pointer position. */
    _updateDropHighlight(x, y) {
        const markers = document.querySelectorAll('.drop-target');
        let closest = null;
        let closestDist = Infinity;

        markers.forEach(marker => {
            const rect = marker.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dist = Math.hypot(x - cx, y - cy);
            marker.classList.remove('highlight');
            if (dist < closestDist) {
                closestDist = dist;
                closest = marker;
            }
        });

        if (closest && closestDist < 150) {
            closest.classList.add('highlight');
        }
    },

    /** Get the side of the drop target under the pointer, or null. */
    _getDropTarget(x, y) {
        const markers = document.querySelectorAll('.drop-target');
        for (const marker of markers) {
            const rect = marker.getBoundingClientRect();
            // Generous hit area (expanded by 30px)
            if (x >= rect.left - 30 && x <= rect.right + 30 &&
                y >= rect.top - 30 && y <= rect.bottom + 30) {
                return marker.dataset.side;
            }
        }

        // Fallback: if only one marker and ghost is in the board area, accept it
        if (markers.length === 1) {
            const boardContainer = document.getElementById('board-container');
            const boardRect = boardContainer.getBoundingClientRect();
            if (y >= boardRect.top && y <= boardRect.bottom) {
                return markers[0].dataset.side;
            }
        }

        return null;
    },

    /** Clean up drag state and DOM elements. */
    _cleanupDrag() {
        if (this._dragState) {
            if (this._dragState.ghost) {
                this._dragState.ghost.remove();
            }
            if (this._dragState.sourceEl) {
                this._dragState.sourceEl.classList.remove('dragging');
            }
        }
        this._removeDropMarkers();
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
