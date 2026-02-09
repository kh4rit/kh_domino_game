/**
 * Procedural sound effects using Web Audio API.
 * Global SFX singleton with mute toggle persisted in localStorage.
 */
const SFX = {
    _ctx: null,
    _muted: false,

    /** Initialize audio context and load mute preference. */
    init() {
        this._muted = localStorage.getItem("sfx_muted") === "1";
        this._updateMuteButton();
    },

    /** Lazy-init AudioContext (must be called after user gesture). */
    _ensureContext() {
        if (!this._ctx) {
            this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._ctx.state === "suspended") {
            this._ctx.resume();
        }
        return this._ctx;
    },

    /** Toggle mute and persist. */
    toggleMute() {
        this._muted = !this._muted;
        localStorage.setItem("sfx_muted", this._muted ? "1" : "0");
        this._updateMuteButton();
    },

    /** Update the mute button icon. */
    _updateMuteButton() {
        const btn = document.getElementById("btn-mute");
        if (btn) {
            btn.textContent = this._muted ? "\u{1F507}" : "\u{1F50A}";
            btn.title = this._muted ? "Unmute" : "Mute";
        }
    },

    /** Play a short noise burst (tile placed on board). */
    tilePlaced() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        // Short noise burst for a "clack" sound
        const duration = 0.08;
        const bufferSize = ctx.sampleRate * duration;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 8);
        }

        const src = ctx.createBufferSource();
        src.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 1200;
        filter.Q.value = 2;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(t);
        src.stop(t + duration);
    },

    /** Two-tone ascending chime (your turn notification). */
    yourTurn() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        [523, 659].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, t + i * 0.12);
            gain.gain.linearRampToValueAtTime(0.25, t + i * 0.12 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.2);

            osc.connect(gain).connect(ctx.destination);
            osc.start(t + i * 0.12);
            osc.stop(t + i * 0.12 + 0.2);
        });
    },

    /** Short soft pop (drawing a tile). */
    draw() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(600, t);
        osc.frequency.exponentialRampToValueAtTime(200, t + 0.1);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.12);
    },

    /** Triumphant ascending arpeggio (you win). */
    gameWin() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        [523, 659, 784, 1047].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = "triangle";
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, t + i * 0.1);
            gain.gain.linearRampToValueAtTime(0.3, t + i * 0.1 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.4);

            osc.connect(gain).connect(ctx.destination);
            osc.start(t + i * 0.1);
            osc.stop(t + i * 0.1 + 0.4);
        });
    },

    /** Descending tones (you lose). */
    gameLose() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        [392, 330, 262].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = "triangle";
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, t + i * 0.15);
            gain.gain.linearRampToValueAtTime(0.25, t + i * 0.15 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.35);

            osc.connect(gain).connect(ctx.destination);
            osc.start(t + i * 0.15);
            osc.stop(t + i * 0.15 + 0.35);
        });
    },

    /** Bubbly warble (fish / draw game). */
    fish() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(400, t);
        osc.frequency.linearRampToValueAtTime(600, t + 0.15);
        osc.frequency.linearRampToValueAtTime(350, t + 0.3);
        osc.frequency.linearRampToValueAtTime(500, t + 0.45);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.5);
    },

    /** Short buzz (error / invalid action). */
    error() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = 150;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
    },

    /** Urgent tick (timer warning, < 5 seconds). */
    timerWarning() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 880;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.06);
    },

    /** Soft whoosh (player passes). */
    pass() {
        if (this._muted) return;
        const ctx = this._ensureContext();
        const t = ctx.currentTime;

        const duration = 0.15;
        const bufferSize = ctx.sampleRate * duration;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 4);
        }

        const src = ctx.createBufferSource();
        src.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(2000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + duration);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(t);
        src.stop(t + duration);
    },
};
