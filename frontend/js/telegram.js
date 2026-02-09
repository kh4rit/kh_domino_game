/**
 * Telegram WebApp SDK integration.
 */
const TG = {
    webapp: null,
    user: null,
    initData: '',
    themeParams: {},

    init() {
        if (window.Telegram && window.Telegram.WebApp) {
            this.webapp = window.Telegram.WebApp;
            this.webapp.expand();
            this.webapp.ready();

            this.initData = this.webapp.initData || '';
            this.user = this.webapp.initDataUnsafe?.user || null;
            this.themeParams = this.webapp.themeParams || {};

            // Disable closing confirmation
            this.webapp.enableClosingConfirmation();

            console.log('Telegram WebApp initialized', this.user);
        } else {
            console.warn('Telegram WebApp SDK not available — running in dev mode');
            // Dev fallback
            this.user = { id: 0, first_name: 'Dev', last_name: 'Player' };
            this.initData = '';
        }
    },

    getPlayerId() {
        return this.user ? this.user.id : 0;
    },

    getPlayerName() {
        if (!this.user) return 'Unknown';
        let name = this.user.first_name || '';
        if (this.user.last_name) name += ' ' + this.user.last_name;
        return name;
    },

    hapticFeedback(type) {
        if (this.webapp && this.webapp.HapticFeedback) {
            switch (type) {
                case 'light':
                    this.webapp.HapticFeedback.impactOccurred('light');
                    break;
                case 'medium':
                    this.webapp.HapticFeedback.impactOccurred('medium');
                    break;
                case 'heavy':
                    this.webapp.HapticFeedback.impactOccurred('heavy');
                    break;
                case 'success':
                    this.webapp.HapticFeedback.notificationOccurred('success');
                    break;
                case 'error':
                    this.webapp.HapticFeedback.notificationOccurred('error');
                    break;
                case 'warning':
                    this.webapp.HapticFeedback.notificationOccurred('warning');
                    break;
            }
        }
    },

    close() {
        if (this.webapp) {
            this.webapp.close();
        }
    }
};
