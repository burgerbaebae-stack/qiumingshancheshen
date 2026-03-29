// js/modules/background_keep_alive.js
// 后台保活模块
//
// · Chrome / Firefox / 等：Web Audio — 单样本静音 BufferSource loop + 增益 0，无 HTML5 Audio 解码循环。
// · Safari / iOS WebKit：系统会强力挂起 AudioContext，单独使用 Web Audio 往往无效；改用 <audio> 静音循环
//   以走媒体播放通道。静音 WAV 的 data URL 仅在模块加载时构建一次并缓存，避免每次开关重复分配与 btoa。
//
// 关闭时两类路径分别彻底释放；无定时器、无轮询。

const BackgroundKeepAliveModule = (() => {

    const STORAGE_KEY = 'bg_keep_alive_enabled';

    /** 模块初始化时只算一次，供 WebKit 媒体回退使用（非每次 _start 动态生成）。 */
    const SILENT_WAV_DATA_URL = (() => {
        try {
            const sampleRate = 8000;
            const numSamples = 800;
            const buf = new ArrayBuffer(44 + numSamples);
            const v = new DataView(buf);
            const writeStr = (off, str) => {
                for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i));
            };
            writeStr(0, 'RIFF');
            v.setUint32(4, 36 + numSamples, true);
            writeStr(8, 'WAVE');
            writeStr(12, 'fmt ');
            v.setUint32(16, 16, true);
            v.setUint16(20, 1, true);
            v.setUint16(22, 1, true);
            v.setUint32(24, sampleRate, true);
            v.setUint32(28, sampleRate, true);
            v.setUint16(32, 1, true);
            v.setUint16(34, 8, true);
            writeStr(36, 'data');
            v.setUint32(40, numSamples, true);
            for (let i = 0; i < numSamples; i++) v.setUint8(44 + i, 128);
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
            return 'data:audio/wav;base64,' + btoa(bin);
        } catch (e) {
            return '';
        }
    })();

    let _ctx = null;
    let _src = null;
    let _gain = null;
    let _audioEl = null;
    let _enabled = false;
    let _onVisibility = null;

    function _needsWebKitMediaFallback() {
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
        if (/iPhone|iPod|iPad/i.test(ua)) return true;
        if (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
            return true;
        }
        if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Opera|Android/i.test(ua)) {
            return true;
        }
        return false;
    }

    function _getAudioContextCtor() {
        return window.AudioContext || window.webkitAudioContext || null;
    }

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

    function _tryPlayHtmlAudio(audio) {
        const promise = audio.play();
        if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {
                const resume = () => {
                    audio.play().catch(() => {});
                };
                document.addEventListener('touchstart', resume, { once: true, passive: true });
                document.addEventListener('click', resume, { once: true });
            });
        }
    }

    function _startWebAudio() {
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

        _ctx = ctx;
        _src = graph.src;
        _gain = graph.gain;

        _resumeContextIfNeeded();
        if (_ctx.state === 'suspended') {
            _attachGestureResumeOnce();
        }
    }

    function _startHtmlAudio() {
        if (!SILENT_WAV_DATA_URL) return;
        const audio = new Audio();
        audio.src = SILENT_WAV_DATA_URL;
        audio.loop = true;
        audio.volume = 0;
        audio.muted = false;
        _tryPlayHtmlAudio(audio);
        _audioEl = audio;

        _onVisibility = () => {
            if (!_enabled || !_audioEl || document.visibilityState !== 'visible') return;
            if (_audioEl.paused) {
                _tryPlayHtmlAudio(_audioEl);
            }
        };
        document.addEventListener('visibilitychange', _onVisibility);
    }

    function _stopWebAudio() {
        if (_src) {
            try {
                _src.stop(0);
            } catch (e) {}
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

    function _stopHtmlAudio() {
        if (_onVisibility) {
            document.removeEventListener('visibilitychange', _onVisibility);
            _onVisibility = null;
        }
        if (_audioEl) {
            _audioEl.pause();
            _audioEl.removeAttribute('src');
            _audioEl.load();
            _audioEl = null;
        }
    }

    function _start() {
        if (_ctx || _audioEl) return;
        if (_needsWebKitMediaFallback()) {
            _startHtmlAudio();
        } else {
            _startWebAudio();
        }
    }

    function _stop() {
        _stopWebAudio();
        _stopHtmlAudio();
    }

    // ── 公开方法 ──────────────────────────────────────────────────

    function setEnabled(val) {
        _enabled = !!val;
        localStorage.setItem(STORAGE_KEY, _enabled ? '1' : '0');

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
