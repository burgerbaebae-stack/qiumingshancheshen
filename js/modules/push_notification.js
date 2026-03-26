// js/modules/push_notification.js
// 后台弹窗通知模块
// 负责管理系统 Notification 权限的申请与弹窗触发。
// 与 chat_ai 收到回复提示音分流一致：
//   · 前台且停留在该会话聊天室 → 不弹系统通知（仅网页内 playSound）
//   · 后台 / 锁屏 / 其它会话 → 弹系统 Notification（不设 silent），且 chat_ai 侧禁止网页内收到音
// 兼容策略：所有 Notification API 调用均有能力检测守卫，
// 在 iOS PWA（Safari）等不支持通知 API 的环境中静默降级，绝不抛出异常。

const PushNotificationModule = (() => {

    const STORAGE_KEY = 'bg_push_notification_enabled';

    let _enabled = false;

    // ── 能力检测 ─────────────────────────────────────────────────

    function _isSupported() {
        return (typeof Notification !== 'undefined') && ('Notification' in window);
    }

    function _isGranted() {
        return _isSupported() && Notification.permission === 'granted';
    }

    // ── 权限申请 ─────────────────────────────────────────────────

    async function _requestPermission() {
        if (!_isSupported()) {
            if (typeof showToast === 'function') {
                showToast('当前浏览器不支持系统通知');
            }
            return false;
        }
        if (Notification.permission === 'granted') {
            return true;
        }
        if (Notification.permission === 'denied') {
            if (typeof showToast === 'function') {
                showToast('通知权限已被拒绝，请在系统设置中手动开启');
            }
            return false;
        }
        // 'default' 状态 —— 向用户弹出系统级权限请求
        try {
            const result = await Notification.requestPermission();
            return result === 'granted';
        } catch (e) {
            console.warn('[PushNotification] requestPermission 失败:', e);
            return false;
        }
    }

    // ── 开关控制 ─────────────────────────────────────────────────

    async function setEnabled(val) {
        if (val) {
            // 首次（或重新）开启时检查权限
            if (!_isGranted()) {
                const granted = await _requestPermission();
                if (!granted) {
                    // 权限获取失败，将开关恢复为关闭
                    const sw = document.getElementById('bg-push-notification-switch');
                    if (sw) sw.checked = false;
                    return;
                }
            }
        }

        _enabled = !!val;
        localStorage.setItem(STORAGE_KEY, _enabled ? '1' : '0');

        // 同步 UI 状态
        const sw = document.getElementById('bg-push-notification-switch');
        if (sw) sw.checked = _enabled;

        if (typeof showToast === 'function') {
            showToast(_enabled ? '后台弹窗通知已开启' : '后台弹窗通知已关闭');
        }
    }

    // ── 前台 / 当前会话判定（与提示音分流共用）────────────────────────

    /**
     * 用户是否处于「前台 + 正在该 chatId 的聊天室」——仅此场景允许网页内收到提示音，且禁止系统 Notification。
     * 切后台、锁屏、或其它会话：返回 false，走系统通知与系统提示音。
     */
    function isForegroundActiveThisChat(chatId) {
        if (document.hidden) return false;
        const chatRoomScreen = document.getElementById('chat-room-screen');
        const isOnThisChat = chatRoomScreen &&
            chatRoomScreen.classList.contains('active') &&
            chatRoomScreen.classList.contains(`chat-active-${chatId}`);
        return !!isOnThisChat;
    }

    // ── 通知触发 ─────────────────────────────────────────────────

    /**
     * 在满足条件时发送系统通知。
     * @param {string} chatId       - 消息来源的聊天 ID
     * @param {string} chatType     - 'private' | 'group'
     * @param {string} senderName   - 显示在通知标题中的名称
     * @param {string} messageText  - 通知正文（预览文本）
     */
    function notify(chatId, chatType, senderName, messageText) {
        if (!_enabled || !_isGranted()) return;
        // 前台且停留在正在收消息的当前聊天：不弹系统通知（提示音仅由网页内逻辑播放）
        if (isForegroundActiveThisChat(chatId)) return;
        _showNotification(chatId, senderName, messageText);
    }

    /** 全局剥离系统类标记（拆分前只做这一层，保留普通方括号供结构识别） */
    function _stripSystemMarkers(raw) {
        return String(raw || '')
            .replace(/\[system:.*?\]/gis, '')
            .replace(/\[system-display:.*?\]/gis, '')
            .replace(/\(时间:.*?\)/g, '')
            .trim();
    }

    /**
     * 将一整段 AI 原文拆成多条独立正文。
     * 识别结构：`[任意昵称的消息：正文]`，正文区间用括号深度配对，支持正文内再出现 [ ]。
     */
    function _splitIntoMessageSegments(raw) {
        const s = _stripSystemMarkers(raw);
        if (!s) return [];

        const segments = [];
        let i = 0;
        const n = s.length;

        while (i < n) {
            const open = s.indexOf('[', i);
            if (open === -1) {
                const tail = s.slice(i).trim();
                if (tail) segments.push(tail);
                break;
            }

            if (open > i) {
                const before = s.slice(i, open).trim();
                if (before) segments.push(before);
            }

            const keyIdx = s.indexOf('的消息', open);
            if (keyIdx === -1) {
                i = open + 1;
                continue;
            }

            const afterKey = s.slice(keyIdx);
            const mKey = afterKey.match(/^的消息[：:]\s*/);
            if (!mKey) {
                i = open + 1;
                continue;
            }

            let depth = 0;
            let j = open;
            for (; j < n; j++) {
                const c = s[j];
                if (c === '[') depth++;
                else if (c === ']') {
                    depth--;
                    if (depth === 0) break;
                }
            }

            if (j >= n || depth !== 0 || keyIdx >= j) {
                i = open + 1;
                continue;
            }

            const prefixEnd = keyIdx + mKey[0].length;
            const inner = s.slice(prefixEnd, j).trim();
            segments.push(inner);
            i = j + 1;
        }

        return segments.length ? segments : (s ? [s] : []);
    }

    /**
     * 单条通知正文：去掉全部 [ ]、去掉「xxx的消息」类前缀，只保留可读正文。
     */
    function _cleanSingleSegment(segment) {
        let s = String(segment || '').trim();
        if (!s) return '';

        s = s.replace(/\[system:.*?\]/gis, '');
        s = s.replace(/\[system-display:.*?\]/gis, '');
        s = s.replace(/\(时间:.*?\)/g, '');

        // 去掉所有方括号字符（含正文里残留的）
        s = s.replace(/[\[\]]/g, '');

        // 去掉开头的「…的消息：」式前缀（可多次，防嵌套残留）
        let prev;
        let guard = 0;
        do {
            prev = s;
            s = s.replace(/^[\s\S]{0,200}?的消息[：:]\s*/u, '').trim();
            guard++;
        } while (s !== prev && guard < 8);

        s = s.replace(/<[^>]+>/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        return s.slice(0, 300);
    }

    function _resolveSenderIconUrl(chatId) {
        if (typeof db === 'undefined') return undefined;
        const char = db.characters && db.characters.find(c => c.id === chatId);
        const grp = !char && db.groups && db.groups.find(g => g.id === chatId);
        const src = char ? char.avatar : (grp ? grp.avatar : undefined);
        if (!src || typeof src !== 'string') return undefined;
        const t = src.trim();
        if (
            t.startsWith('http://') ||
            t.startsWith('https://') ||
            t.startsWith('data:') ||
            t.startsWith('blob:') ||
            t.startsWith('//')
        ) {
            return t;
        }
        return undefined;
    }

    const _STAGGER_MS = 55;

    /**
     * 拆分 → 逐条清洗 → 每条单独一条 Notification（body 绝不合并多句）。
     */
    function _showNotification(chatId, title, rawText) {
        if (!_isSupported()) return;

        const segments = _splitIntoMessageSegments(rawText);
        const cleanedBodies = [];
        for (let k = 0; k < segments.length; k++) {
            const one = _cleanSingleSegment(segments[k]);
            if (one) cleanedBodies.push(one);
        }

        if (cleanedBodies.length === 0) {
            const fallback = _cleanSingleSegment(_stripSystemMarkers(rawText));
            if (fallback) cleanedBodies.push(fallback);
        }
        if (cleanedBodies.length === 0) return;

        const baseTs = Date.now();
        cleanedBodies.forEach((singleBody, idx) => {
            setTimeout(() => {
                _showOneNotification(chatId, title, singleBody, baseTs, idx);
            }, idx * _STAGGER_MS);
        });
    }

    function _showOneNotification(chatId, title, singleBody, baseTs, idx) {
        if (!_isSupported() || !singleBody) return;
        try {
            const iconUrl = _resolveSenderIconUrl(chatId);
            // 不显式设置 silent，避免 silent:true；默认由系统通知携带自带提示音
            const options = {
                body: singleBody,
                tag: `xiaozhangyv-push-${baseTs}-${idx}-${Math.random().toString(36).slice(2, 11)}`
            };
            if (iconUrl) options.icon = iconUrl;

            const n = new Notification(title || '新消息', options);
            n.onclick = () => {
                window.focus();
                n.close();
            };
        } catch (e) {
            console.warn('[PushNotification] 创建通知失败:', e);
        }
    }

    // ── 初始化 ────────────────────────────────────────────────────

    function init() {
        _enabled = localStorage.getItem(STORAGE_KEY) === '1';

        // 若保存为"开启"但权限已被撤销，则重置为关闭
        if (_enabled && !_isGranted()) {
            _enabled = false;
            localStorage.setItem(STORAGE_KEY, '0');
        }

        const sw = document.getElementById('bg-push-notification-switch');
        if (sw) {
            sw.checked = _enabled;
            sw.addEventListener('change', e => setEnabled(e.target.checked));
        }
    }

    // ── 自动初始化 ─────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, setEnabled, notify, isForegroundActiveThisChat };

})();
