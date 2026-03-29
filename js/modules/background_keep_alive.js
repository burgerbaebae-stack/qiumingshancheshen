// js/modules/background_keep_alive.js
// 后台保活模块
// 原理：在用户开启开关时创建 Web Audio API 图：单帧静音 BufferSource 循环 + 增益 0，
// 维持「活跃音频上下文」以配合系统媒体策略，避免主线程上 HTML5 Audio 高频 loop 解码与内存压力。
// 关闭时 stop → disconnect → suspend → close，完整释放，无定时器、无轮询。

const BackgroundKeepAliveModule = (() => {

    const STORAGE_KEY = 'bg_keep_alive_enabled';

    let _ctx   = null;
    let _src   = null;
    let _gain  = null;
    let _enabled = false;

    function _getAudioContextCtor() {
        return window.AudioContext || window.webkitAudioContext || null;
    }

    /** 构建极简静音图：1 样本缓冲 loop，增益 0，音频线程侧近乎零输出。 */
    function _wireSilentGraph(ctx) {
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
        return { src, gain };
    }

    function _resumeContextIfNeeded() {
        if (!_ctx || _ctx.state !== 'suspended') return;
        const p = _ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    function _attachGestureResumeOnce() {
        const resume = () => {
            _resumeContextIfNeeded();
        };
        document.addEventListener('touchstart', resume, { once: true, passive: true });
        document.addEventListener('click', resume, { once: true });
    }

    function _start() {
        if (_ctx) return;

        const Ctor = _getAudioContextCtor();
        if (!Ctor) return;

        let ctx;
        try {
            ctx = new Ctor();
        } catch (e) {
            return;
        }

        let graph;
        try {
            graph = _wireSilentGraph(ctx);
        } catch (e) {
            ctx.close().catch(() => {});
            return;
        }

        _ctx  = ctx;
        _src  = graph.src;
        _gain = graph.gain;

        _resumeContextIfNeeded();
        if (_ctx.state === 'suspended') {
            _attachGestureResumeOnce();
        }
    }

    function _stop() {
        if (_src) {
            try {
                _src.stop(0);
            } catch (e) {
                /* 已 stop 或无效 */
            }
            try {
                _src.disconnect();
            } catch (e) {}
            _src = null;
        }
        if (_gain) {
            try {
                _gain.disconnect();
            } catch (e) {}
            _gain = null;
        }
        if (_ctx) {
            const c = _ctx;
            _ctx = null;
            const s = c.suspend();
            if (s && typeof s.then === 'function') {
                s.catch(() => {}).then(() => c.close().catch(() => {}));
            } else {
                c.close().catch(() => {});
            }
        }
    }

    // ── 公开方法 ──────────────────────────────────────────────────

    function setEnabled(val) {
        _enabled = !!val;
        localStorage.setItem(STORAGE_KEY, _enabled ? '1' : '0');

        // 同步开关 UI 状态（可能从外部调用）
        const sw = document.getElementById('bg-keepalive-switch');
        if (sw) sw.checked = _enabled;

        if (_enabled) {
            _start();
            if (typeof showToast === 'function') showToast('后台潜行模式已开启 🌙');
        } else {
            _stop();
            if (typeof showToast === 'function') showToast('后台潜行模式已关闭');
        }
    }

    function init() {
        _enabled = localStorage.getItem(STORAGE_KEY) === '1';

        const sw = document.getElementById('bg-keepalive-switch');
        if (sw) {
            sw.checked = _enabled;
            sw.addEventListener('change', e => setEnabled(e.target.checked));
        }

        if (_enabled) _start();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, setEnabled };

})();
