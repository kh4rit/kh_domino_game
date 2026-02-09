/**
 * WebSocket client for real-time game updates.
 */
const WS = {
    socket: null,
    gameId: null,
    playerId: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    reconnectDelay: 1000,
    onMessage: null,
    pingInterval: null,

    connect(gameId, playerId) {
        this.gameId = gameId;
        this.playerId = playerId;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws/${gameId}/${playerId}`;

        console.log('WS connecting to:', url);

        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            console.log('WS connected');
            this.reconnectAttempts = 0;
            this._startPing();
        };

        this.socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'pong') return;
                if (this.onMessage) {
                    this.onMessage(msg);
                }
            } catch (e) {
                console.error('WS parse error:', e);
            }
        };

        this.socket.onclose = (event) => {
            console.log('WS closed:', event.code, event.reason);
            this._stopPing();
            this._tryReconnect();
        };

        this.socket.onerror = (error) => {
            console.error('WS error:', error);
        };
    },

    _startPing() {
        this._stopPing();
        this.pingInterval = setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 25000);
    },

    _stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    },

    _tryReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('WS max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
        console.log(`WS reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        setTimeout(() => {
            if (this.gameId && this.playerId) {
                this.connect(this.gameId, this.playerId);
            }
        }, delay);
    },

    disconnect() {
        this._stopPing();
        if (this.socket) {
            this.socket.onclose = null; // Prevent reconnect
            this.socket.close();
            this.socket = null;
        }
    }
};
