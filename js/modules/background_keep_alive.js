// js/modules/background_keep_alive.js
// 后台保活模块
// 原理：在内存中动态生成一段极短的无声 WAV 音频（等同于 Base64 内嵌），
// 以 loop 方式静默循环播放，触发浏览器的媒体会话机制，
// 阻止系统在后台挂起网页进程，确保 API 轮询持续运作。

const BackgroundKeepAliveModule = (() => {

    const STORAGE_KEY = 'bg_keep_alive_enabled';

    let _audioEl  = null;
    let _enabled  = false;

    // ── 内存生成静音 WAV ──────────────────────────────────────────
    // 规格：8 kHz / 8-bit / mono / 0.1 秒（800 样本）
    // 完全等价于一段 Base64 编码的内嵌音频，不依赖任何外部文件。
    function _buildSilentWavDataUrl() {
        const sampleRate  = 8000;
        const numSamples  = 800;                    // 0.1 s
        const buf         = new ArrayBuffer(44 + numSamples);
        const v           = new DataView(buf);

        const writeStr = (off, str) => {
            for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i));
        };

        // RIFF 头
        writeStr(0,  'RIFF');
        v.setUint32(4, 36 + numSamples, true);      // 文件总大小 - 8
        writeStr(8,  'WAVE');
        // fmt  块
        writeStr(12, 'fmt ');
        v.setUint32(16, 16,         true);           // 块大小
        v.setUint16(20,  1,         true);           // PCM
        v.setUint16(22,  1,         true);           // 单声道
        v.setUint32(24, sampleRate, true);           // 采样率
        v.setUint32(28, sampleRate, true);           // 字节率 = sampleRate×1×1
        v.setUint16(32,  1,         true);           // 块对齐
        v.setUint16(34,  8,         true);           // 位深
        // data 块
        writeStr(36, 'data');
        v.setUint32(40, numSamples, true);
        for (let i = 0; i < numSamples; i++) {
            v.setUint8(44 + i, 128);                // 0x80 = 8-bit 无符号 PCM 静音
        }

        // 转换为 Base64 data URL
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        return 'data:audio/wav;base64,' + btoa(bin);
    }

    // ── 播放控制 ──────────────────────────────────────────────────

    function _start() {
        if (_audioEl) return;

        const audio   = new Audio();
        audio.src     = _buildSilentWavDataUrl();
        audio.loop    = true;
        audio.volume  = 0;
        // 注意：muted=true 会被部分浏览器忽略媒体会话，必须保持 false
        audio.muted   = false;

        const promise = audio.play();
        if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {
                // 自动播放策略阻止时，等待用户下一次手势后重试
                const resume = () => audio.play().catch(() => {});
                document.addEventListener('touchstart', resume, { once: true });
                document.addEventListener('click',      resume, { once: true });
            });
        }

        _audioEl = audio;
    }

    function _stop() {
        if (_audioEl) {
            _audioEl.pause();
            _audioEl.src = '';
            _audioEl = null;
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

        // 若上次退出时保活处于开启状态，则恢复播放
        if (_enabled) _start();
    }

    // ── 自动初始化 ────────────────────────────────────────────────
    // 脚本在 <body> 底部加载，DOM 已完全解析，可以直接调用 init()。
    // 同时兼容极少数未解析完成的场景。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, setEnabled };

})();
