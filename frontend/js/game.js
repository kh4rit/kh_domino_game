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

        // For horizontal: first half = left, second half = right.
        // For vertical: first half = top, second half = bottom.
        // Board tiles use exposedLeft/exposedRight (horizontal) or exposedTop/exposedBottom (vertical).
        let firstValue, secondValue;
        if (orientation === 'horizontal') {
            firstValue = options.exposedLeft !== undefined ? options.exposedLeft : tile.left;
            secondValue = options.exposedRight !== undefined ? options.exposedRight : tile.right;
        } else {
            firstValue = options.exposedTop !== undefined ? options.exposedTop : tile.left;
            secondValue = options.exposedBottom !== undefined ? options.exposedBottom : tile.right;
        }

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

    /** Stored snake layout positions for drop marker placement. */
    _snakeLayout: null,

    /**
     * Compute tile dimensions from CSS.
     */
    _getTileDims() {
        const boardEl = document.getElementById('board');
        const tempTile = document.createElement('div');
        tempTile.className = 'domino-tile horizontal';
        tempTile.style.visibility = 'hidden';
        tempTile.style.position = 'absolute';
        boardEl.appendChild(tempTile);
        const tileSize = parseInt(getComputedStyle(tempTile).getPropertyValue('--tile-size')) || 34;
        tempTile.remove();

        const half = tileSize + 4;  // one half width including border
        return {
            half,
            tileW: half * 2,        // horizontal non-double width
            tileH: half,            // horizontal non-double height
            doubleW: half,          // double rendered vertical: width
            doubleH: half * 2,      // double rendered vertical: height
            gap: 0,                 // tiles touch — no gap
            turnLen: 1,             // single tile in a vertical turn segment
        };
    },

    /**
     * Get the dimensions and orientation for a tile given the current flow direction.
     * Horizontal flow: non-doubles horizontal, doubles vertical (perpendicular).
     * Vertical flow (up/down): non-doubles vertical (rotated), doubles horizontal (perpendicular).
     */
    _tileLayout(bt, flowDir, dims) {
        const isDouble = bt.tile.left === bt.tile.right;
        if (flowDir === 'right' || flowDir === 'left') {
            return isDouble
                ? { w: dims.doubleW, h: dims.doubleH, orientation: 'vertical', isDouble }
                : { w: dims.tileW, h: dims.tileH, orientation: 'horizontal', isDouble };
        } else {
            // Vertical flow (up or down)
            return isDouble
                ? { w: dims.tileW, h: dims.tileH, orientation: 'horizontal', isDouble }
                : { w: dims.doubleW, h: dims.doubleH, orientation: 'vertical', isDouble };
        }
    },

    /** Row height for horizontal flow — tallest possible tile (a double). */
    _rowHeight(dims) { return dims.doubleH; },

    /** Column width for vertical flow — widest possible tile (a double horizontal). */
    _colWidth(dims) { return dims.tileW; },

    /**
     * Lay out a chain of tiles going outward from the center tile.
     *
     * direction: 'right' or 'left' (initial horizontal direction).
     * vDir: 1 (down) or -1 (up) — which vertical direction turns go.
     *   Right chain turns DOWN (vDir=1), left chain turns UP (vDir=-1).
     *
     * Doubles never trigger a turn — they always stay in horizontal flow,
     * even if they extend past the container edge. Only non-doubles turn.
     * Each turn uses exactly 1 vertical tile.
     *
     * First row: tiles centered in rowH. Subsequent rows: tiles top-aligned
     * (vDir=1) or bottom-aligned (vDir=-1) at the turn tile's outward edge.
     * Turn tiles connect tile-to-tile to the last horizontal tile.
     *
     * Returns array of {x, y, w, h, orientation, isDouble, bt, flowDir}.
     */
    _layoutChain(tiles, startX, startY, direction, vDir, dims, containerWidth) {
        const padding = 12;
        const positions = [];
        let x = startX;
        let hDir = direction === 'right' ? 1 : -1;
        let flowDir = direction;
        const rowH = this._rowHeight(dims);
        const vFlow = vDir === 1 ? 'down' : 'up';

        // Track the last placed tile for precise corner alignment
        let lastPos = null;

        // rowEdgeY: the Y coordinate of the current row's connecting edge.
        // First row: centering box top (tiles centered within rowH).
        // Subsequent rows: the edge where tiles touch the turn tile.
        //   vDir=1: top edge (tiles extend downward).
        //   vDir=-1: bottom edge (tiles extend upward).
        let rowEdgeY = startY;
        let isFirstRow = true;

        for (let i = 0; i < tiles.length; i++) {
            const bt = tiles[i];
            const layout = this._tileLayout(bt, flowDir, dims);
            const { w, h, orientation, isDouble } = layout;

            // --- Overflow check (doubles exempt — they never trigger turns) ---
            const overflowR = hDir === 1 && (x + w > containerWidth - padding);
            const overflowL = hDir === -1 && (x - w < padding);

            if ((overflowR || overflowL) && !isDouble && i > 0 && lastPos) {
                // === PLACE SINGLE VERTICAL TURN TILE ===
                const vLayout = this._tileLayout(bt, vFlow, dims);
                const vw = vLayout.w;
                const vh = vLayout.h;

                // Align to the outward edge of the last horizontal tile.
                let tileX;
                if (hDir === 1) {
                    tileX = lastPos.x + lastPos.w - vw;
                } else {
                    tileX = lastPos.x;
                }
                const turnColX = tileX;
                const turnColW = vw;

                // Vertically: connect tile-to-tile with the last horizontal tile.
                // vDir=1 (down): turn tile starts at last tile's bottom edge.
                // vDir=-1 (up): turn tile ends at last tile's top edge.
                const tileY = vDir === 1
                    ? lastPos.y + lastPos.h
                    : lastPos.y - vh;

                positions.push({
                    x: tileX, y: tileY, w: vw, h: vh,
                    orientation: vLayout.orientation, isDouble: vLayout.isDouble,
                    bt, flowDir: vFlow,
                });
                lastPos = positions[positions.length - 1];

                // === TRANSITION TO NEW HORIZONTAL ROW ===
                hDir = -hDir;
                flowDir = hDir === 1 ? 'right' : 'left';

                // X cursor: start from the turn tile's outer edge.
                if (hDir === -1) {
                    x = turnColX + turnColW;
                } else {
                    x = turnColX;
                }

                // New rowEdgeY: the turn tile's outward edge becomes the
                // connecting edge for the next horizontal row.
                rowEdgeY = vDir === 1
                    ? tileY + vh
                    : tileY;
                isFirstRow = false;

                continue;
            }

            // --- Place tile in current horizontal row ---
            const tileX = hDir === 1 ? x : x - w;
            let tileY;
            if (isFirstRow) {
                // First row: center vertically within rowH.
                tileY = rowEdgeY + (rowH - h) / 2;
            } else {
                // Subsequent rows: align at the connecting edge (flush with turn tile).
                // vDir=1 (down): tile top = rowEdgeY. Doubles extend further down.
                // vDir=-1 (up): tile bottom = rowEdgeY. Doubles extend further up.
                tileY = vDir === 1 ? rowEdgeY : rowEdgeY - h;
            }

            positions.push({
                x: tileX, y: tileY, w, h,
                orientation, isDouble, bt, flowDir,
            });
            lastPos = positions[positions.length - 1];

            x = hDir === 1 ? tileX + w : tileX;
        }

        return positions;
    },

    /**
     * Map backend exposed_left / exposed_right to visual half positions.
     *
     * Backend: exposed_left = closer to board[0], exposed_right = closer to board[-1].
     * Right chain: exposed_left faces center (inward), exposed_right faces away (outward).
     * Left chain: exposed_right faces center (inward), exposed_left faces away (outward).
     */
    _getTileExposedValues(bt, orientation, flowDir, chainSide) {
        let inward, outward;
        if (chainSide === 'right') {
            inward = bt.exposed_left;
            outward = bt.exposed_right;
        } else {
            inward = bt.exposed_right;
            outward = bt.exposed_left;
        }

        if (orientation === 'horizontal') {
            if (flowDir === 'right') {
                return { exposedLeft: inward, exposedRight: outward };
            } else if (flowDir === 'left') {
                return { exposedLeft: outward, exposedRight: inward };
            } else {
                // Double perpendicular to vertical flow
                return { exposedLeft: bt.exposed_left, exposedRight: bt.exposed_right };
            }
        } else {
            // Vertical orientation
            if (flowDir === 'down') {
                // Down: top = inward (toward center/previous), bottom = outward
                return { exposedTop: inward, exposedBottom: outward };
            } else if (flowDir === 'up') {
                // Up: bottom = inward (toward center/previous), top = outward
                return { exposedTop: outward, exposedBottom: inward };
            } else {
                // Double perpendicular to horizontal flow
                return { exposedTop: bt.exposed_left, exposedBottom: bt.exposed_right };
            }
        }
    },

    /**
     * Render the game board as a snake/S-shape layout.
     * Center tile at the exact center. Right chain goes right then turns DOWN.
     * Left chain goes left then turns UP. They grow apart vertically.
     * All positions are deterministic from the board array + first_tile_index.
     */
    renderBoard(state) {
        const boardEl = document.getElementById('board');
        boardEl.innerHTML = '';
        this._snakeLayout = null;

        if (!state.board || state.board.length === 0) {
            boardEl.classList.add('empty');
            boardEl.style.height = '';
            boardEl.style.width = '';
            return;
        }

        boardEl.classList.remove('empty');

        const container = document.getElementById('board-container');
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const dims = this._getTileDims();
        const padding = 12;
        const rowH = this._rowHeight(dims);

        // Center tile index from server (deterministic)
        const centerIdx = state.first_tile_index !== undefined ? state.first_tile_index : 0;
        const centerTile = state.board[centerIdx];
        const leftTiles = state.board.slice(0, centerIdx).reverse();
        const rightTiles = state.board.slice(centerIdx + 1);

        // Center tile layout
        const isCenterDouble = centerTile.tile.left === centerTile.tile.right;
        const centerLayout = this._tileLayout(centerTile, 'right', dims);
        const centerW = centerLayout.w;
        const centerH = centerLayout.h;
        const centerX = Math.floor((containerWidth - centerW) / 2);

        // Use firstRowY = 0 as reference; offset vertically later.
        const firstRowY = 0;
        const centerY = firstRowY + (rowH - centerH) / 2;

        const centerPos = {
            x: centerX, y: centerY, w: centerW, h: centerH,
            isDouble: isCenterDouble, bt: centerTile,
            orientation: centerLayout.orientation,
            flowDir: 'right',
        };

        // Right chain: goes right, turns DOWN (vDir=1)
        const rightStartX = centerX + centerW + dims.gap;
        const rightPositions = this._layoutChain(
            rightTiles, rightStartX, firstRowY, 'right', 1, dims, containerWidth
        );

        // Left chain: goes left, turns UP (vDir=-1)
        const leftStartX = centerX - dims.gap;
        const leftPositions = this._layoutChain(
            leftTiles, leftStartX, firstRowY, 'left', -1, dims, containerWidth
        );

        // Combine (left reversed back to board order)
        const leftReversed = [...leftPositions].reverse();
        const allPositions = [
            ...leftReversed,
            centerPos,
            ...rightPositions,
        ];
        const centerPosIdx = leftReversed.length;

        // Compute bounding box
        let minY = Infinity, maxY = -Infinity;
        for (const pos of allPositions) {
            if (pos.y < minY) minY = pos.y;
            if (pos.y + pos.h > maxY) maxY = pos.y + pos.h;
        }
        const contentH = maxY - minY;

        // Board height: at least the container, or taller if needed
        const boardHeight = Math.max(containerHeight, contentH + padding * 2);

        // Offset Y so center tile is vertically centered in the board
        const centerTileDesiredY = Math.floor(boardHeight / 2 - centerH / 2);
        const offsetY = centerTileDesiredY - centerY;
        for (const pos of allPositions) {
            pos.y += offsetY;
        }

        // Ensure nothing goes above y=padding; shift down if needed
        let topOverflow = 0;
        for (const pos of allPositions) {
            if (pos.y < padding) {
                topOverflow = Math.max(topOverflow, padding - pos.y);
            }
        }
        if (topOverflow > 0) {
            for (const pos of allPositions) {
                pos.y += topOverflow;
            }
        }

        // Recompute final board height
        let finalMaxY = 0;
        for (const pos of allPositions) {
            const bottom = pos.y + pos.h;
            if (bottom > finalMaxY) finalMaxY = bottom;
        }
        const finalBoardHeight = Math.max(containerHeight, finalMaxY + padding);

        boardEl.style.width = `${containerWidth}px`;
        boardEl.style.height = `${finalBoardHeight}px`;

        // Store layout for drop markers
        const leftEnd = leftPositions.length > 0 ? leftPositions[leftPositions.length - 1] : centerPos;
        const rightEnd = rightPositions.length > 0 ? rightPositions[rightPositions.length - 1] : centerPos;
        this._snakeLayout = {
            allPositions, leftEnd, rightEnd, containerWidth, padding, dims,
        };

        // Render tiles
        for (let i = 0; i < allPositions.length; i++) {
            const pos = allPositions[i];
            const chainSide = i < centerPosIdx ? 'left' : 'right';
            const exposed = this._getTileExposedValues(
                pos.bt, pos.orientation, pos.flowDir, chainSide
            );
            const tileEl = this.createTileElement(pos.bt.tile, pos.orientation, {
                boardTile: true,
                ...exposed,
            });
            if (pos.isDouble) tileEl.classList.add('board-double');
            tileEl.style.position = 'absolute';
            tileEl.style.left = `${pos.x}px`;
            tileEl.style.top = `${pos.y}px`;
            boardEl.appendChild(tileEl);
        }

        // Scroll: center on the center tile initially, then follow growth
        requestAnimationFrame(() => {
            const centerTileFinalY = allPositions[centerPosIdx].y;
            if (state.board.length <= 1) {
                container.scrollTop = Math.max(0, centerTileFinalY - containerHeight / 2 + centerH / 2);
            } else if (finalBoardHeight > containerHeight) {
                // Scroll to keep center tile visible
                const idealScroll = centerTileFinalY - containerHeight / 2 + centerH / 2;
                container.scrollTop = Math.max(0, idealScroll);
            }
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
            // Auto-hide after 5 seconds
            setTimeout(() => {
                overlay.classList.add('hidden');
            }, 5000);
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

        // Render leaderboard if provided
        const leaderboardDiv = document.getElementById('session-leaderboard');
        leaderboardDiv.innerHTML = '';
        if (data.leaderboard && data.leaderboard.length > 0) {
            leaderboardDiv.innerHTML = '<h3>Leaderboard</h3>';
            for (let i = 0; i < data.leaderboard.length; i++) {
                const entry = data.leaderboard[i];
                const row = document.createElement('div');
                row.className = 'result-row';
                const isMe = entry.telegram_id === this.playerId;
                const nameClass = isMe ? 'winner' : (entry.is_fish ? 'fish' : '');
                row.innerHTML = `
                    <span class="result-label">${i + 1}. ${this.escapeHtml(entry.display_name)}</span>
                    <span class="result-value ${nameClass}">${entry.wins} win${entry.wins !== 1 ? 's' : ''}</span>
                `;
                leaderboardDiv.appendChild(row);
            }
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
            // Empty board — single center marker in the middle
            if (sides.includes('left')) {
                const marker = this._createMarker('left', 'Play here');
                const container = document.getElementById('board-container');
                marker.style.left = `${(container.clientWidth - 50) / 2}px`;
                marker.style.top = `${(container.clientHeight - 40) / 2}px`;
                boardEl.appendChild(marker);
            }
            return;
        }

        const layout = this._snakeLayout;
        if (!layout) return;

        // Left marker: positioned based on the flow direction at the left end
        if (sides.includes('left')) {
            const pos = layout.leftEnd;
            const marker = this._createMarker('left', `\u25C0 ${this.state.left_end}`);
            this._positionMarkerAtEnd(marker, pos, 'left');
            boardEl.appendChild(marker);
        }

        // Right marker: positioned based on the flow direction at the right end
        if (sides.includes('right')) {
            const pos = layout.rightEnd;
            const marker = this._createMarker('right', `${this.state.right_end} \u25B6`);
            this._positionMarkerAtEnd(marker, pos, 'right');
            boardEl.appendChild(marker);
        }
    },

    /**
     * Position a drop marker adjacent to the chain end, respecting the flow direction.
     * chainSide: 'left' or 'right' — which logical end of the chain.
     */
    _positionMarkerAtEnd(marker, pos, chainSide) {
        const flowDir = pos.flowDir || 'right';
        const markerW = 54;
        const markerH = 44;
        const gap = 4;

        if (flowDir === 'down') {
            marker.style.left = `${pos.x + (pos.w - markerW) / 2}px`;
            marker.style.top = `${pos.y + pos.h + gap}px`;
        } else if (flowDir === 'up') {
            marker.style.left = `${pos.x + (pos.w - markerW) / 2}px`;
            marker.style.top = `${pos.y - markerH - gap}px`;
        } else if (flowDir === 'right') {
            marker.style.left = `${pos.x + pos.w + gap}px`;
            marker.style.top = `${pos.y + (pos.h - markerH) / 2}px`;
        } else {
            // left
            marker.style.left = `${pos.x - markerW - gap}px`;
            marker.style.top = `${pos.y + (pos.h - markerH) / 2}px`;
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
