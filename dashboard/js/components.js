/**
 * Shared UI Components — toast, modal, helpers
 */
const UI = {
    toast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const icon = type === 'success' ? 'check-circle' : 'alert-circle';
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i data-lucide="${icon}"></i><span>${message}</span>`;
        container.appendChild(toast);
        lucide.createIcons({ nodes: [toast] });
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
    },

    showModal(html) {
        const overlay = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');
        content.innerHTML = html;
        overlay.classList.remove('hidden');
        lucide.createIcons({ nodes: [content] });
        overlay.onclick = (e) => { if (e.target === overlay) UI.closeModal(); };
    },

    closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
    },

    formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    animateCounter(el, target, duration = 1200) {
        let start = 0;
        const step = (timestamp) => {
            if (!start) start = timestamp;
            const progress = Math.min((timestamp - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.floor(eased * target).toLocaleString();
            if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    },

    loader() {
        return '<div class="loader"><div class="spinner"></div></div>';
    }
};

// ─── Backwards-compat alias ──────────────────────────────────────────────────
// inbox.js and ai_settings.js use Components.showToast() — map it to UI.toast()
const Components = {
    showToast: (msg, type = 'success') => UI.toast(msg, type)
};
