// js/modules/video_call.js

const CAMERA_ON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-camera-video" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2V5zm11.5 5.175 3.5 1.556V4.269l-3.5 1.556v4.35zM2 4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H2z"/></svg>`;
const CAMERA_OFF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-camera-video-off" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M10.961 12.365a1.99 1.99 0 0 0 .522-1.103l3.11 1.382A1 1 0 0 0 16 11.731V4.269a1 1 0 0 0-1.406-.913l-3.111 1.382A2 2 0 0 0 9.5 3H4.272l.714 1H9.5a1 1 0 0 1 1 1v6a1 1 0 0 1-.144.518l.605.847zM1.428 4.18A.999.999 0 0 0 1 5v6a1 1 0 0 0 1 1h5.014l.714 1H2a2 2 0 0 1-2-2V5c0-.675.334-1.272.847-1.634l.58.814zM15 11.73l-3.5-1.555v-4.35L15 4.269v7.462zm-4.407 3.56-10-14 .814-.58 10 14-.814.58z"/></svg>`;

const VideoCallModule = {
    state: {
        isCallActive: false,
        callType: 'video', // 'video' or 'voice'
        timerInterval: null,
        seconds: 0,
        currentChat: null,
        currentCallContext: [], // 存储当前通话中的消息记录
        startTime: 0,
        isGenerating: false, // 标记是否正在请求AI生成
        initialAiResponse: null, // 存储开场白
        incomingChat: null, // 暂存来电对象
        isMinimized: false, // 是否处于悬浮窗悬浮窗口模式
        // 通话界面内的手动重听播放状态（visual 连读 / voice 单句）
        manualPlayback: null,
        callBackground: null, // 专属通话背景图（由设置面板配置）
        scratchAwaitingAi: false, // 猫爪：发送～AI 完成前的互斥锁（与全局 isGenerating 配合）
        scratchBreathingActive: false,
        scratchBreathTimeoutId: null,
        isMasterPip: false,
        cameraEnabled: false,
        cameraStream: null,
        cameraFacingMode: 'user',
        cameraBurstInProgress: false,
        cameraCountdownActive: false,
        cameraSwapActive: false,
        filmRollFrames: [],
        cameraRippleActive: false,
        cameraRippleTimeoutId: null
    },

    /**
     * 系统忙碌：正在生成文本，或通话 TTS 真实朗读中。
     * TTS：优先读 TTSModule.state.isCallStreamPlaying；DOM 双保险 #vc-tts-indicator.visible
     */
    isSystemBusy: function() {
        if (this.state.isGenerating === true) return true;
        try {
            if (
                typeof TTSModule !== 'undefined' &&
                TTSModule.state &&
                TTSModule.state.isCallStreamPlaying === true
            ) {
                return true;
            }
        } catch (_) {
            /* ignore */
        }
        const ind = document.getElementById('vc-tts-indicator');
        if (ind && ind.classList.contains('visible')) return true;
        return false;
    },

    init: function() {
        // 绑定悬浮窗点击还原事件
        const floatWindow = document.getElementById('vc-floating-window');
        if (floatWindow) {
            floatWindow.addEventListener('click', (e) => {
                // 如果是拖拽结束的点击，不触发恢复
                if (floatWindow.dataset.isDragging === 'true') return;
                this.maximizeCall();
            });
            
            // 初始化悬浮窗拖拽
            this.initDraggable(floatWindow);
        }

        // 绑定弹窗关闭按钮
        const closeBtn = document.getElementById('vc-type-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideCallTypeModal());
        }

        // 绑定发起通话按钮
        const videoBtn = document.getElementById('vc-start-video-btn');
        if (videoBtn) {
            videoBtn.addEventListener('click', () => {
                // 用户点击发起视频通话：在同步栈中预先解锁苹果音频通道
                if (typeof TTSModule !== 'undefined' && typeof TTSModule.unlockAppleAudio === 'function') {
                    TTSModule.unlockAppleAudio();
                }
                this.startCall('video');
            });
        }

        const voiceBtn = document.getElementById('vc-start-voice-btn');
        if (voiceBtn) {
            voiceBtn.addEventListener('click', () => {
                // 用户点击发起语音通话：在同步栈中预先解锁苹果音频通道
                if (typeof TTSModule !== 'undefined' && typeof TTSModule.unlockAppleAudio === 'function') {
                    TTSModule.unlockAppleAudio();
                }
                this.startCall('voice');
            });
        }
        
        const historyBtn = document.getElementById('vc-history-btn');
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                this.hideCallTypeModal();
                this.showHistoryModal();
            });
        }

        // 绑定挂断按钮
        const loadingHangupBtn = document.getElementById('vc-loading-hangup-btn');
        if (loadingHangupBtn) {
            loadingHangupBtn.addEventListener('click', () => this.endCall(true));
        }

        const callHangupBtn = document.getElementById('vc-call-hangup-btn');
        if (callHangupBtn) {
            callHangupBtn.addEventListener('click', () => this.endCall());
        }

        this.initCallCameraControls();

        // 绑定说话按钮 -> 显示输入面板
        const actionVoiceBtn = document.getElementById('vc-action-voice-btn');
        if (actionVoiceBtn) {
            actionVoiceBtn.addEventListener('click', () => {
                const overlay = document.getElementById('vc-input-overlay');
                const input = document.getElementById('vc-input-text');
                const chatArea = document.getElementById('vc-chat-container');
                
                overlay.style.display = 'flex';
                if (chatArea) {
                    // 稍微延迟滚动，等过渡动画开始后再滚动
                    setTimeout(() => {
                        chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: 'smooth' });
                    }, 50);
                }
                input.focus();
            });
        }

        // 新主卧：麦克风与挂断键
        const masterMicBtn = document.getElementById('vc-master-mic-btn');
        if (masterMicBtn) {
            masterMicBtn.addEventListener('click', () => {
                // 新主卧：麦克风按钮仅控制输入浮层显示/隐藏（不强制唤起键盘）
                const overlay = document.getElementById('vc-master-input-overlay');
                const input = document.getElementById('vc-master-input-text');
                if (!overlay || !input) return;

                const isVisible = overlay.style.display === 'block';
                if (isVisible) {
                    overlay.style.display = 'none';
                    input.blur();
                } else {
                    if (this.isSystemBusy()) {
                        showToast('正在说话，请稍后操作。');
                        return;
                    }
                    overlay.style.display = 'block';
                    if (typeof TTSModule !== 'undefined' && typeof TTSModule.unlockAppleAudio === 'function') {
                        TTSModule.unlockAppleAudio();
                    }
                    // 不在这里主动 focus，交给用户手指点进输入框再由浏览器调起键盘
                }
            });
        }

        const masterHangupBtn = document.getElementById('vc-master-hangup-btn');
        if (masterHangupBtn) {
            masterHangupBtn.addEventListener('click', () => this.endCall());
        }

        // 新主卧：羽毛图标 -> 进入历史档案室（旧通话界面）
        const masterVinylBtn = document.getElementById('vc-master-vinyl-btn');
        if (masterVinylBtn) {
            masterVinylBtn.addEventListener('click', () => {
                // 仅做界面切换，通话与 TTS 逻辑保持不变
                this.hideImmersiveSceneToArchive();
            });
        }

        // 新主卧：白乌鸦 → 全局画中画（pip-mode）
        const ravenBtn = document.getElementById('vc-master-raven-btn');
        if (ravenBtn) {
            ravenBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.enterMasterPip();
            });
        }

        // 新主卧：胶片相册入口按钮
        const filmRollBtn = document.getElementById('vc-film-roll-btn');
        if (filmRollBtn) {
            filmRollBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openFilmAlbum();
            });
        }

        this.initMasterPipInteraction();

        // 绑定输入框发送逻辑（仅回车 + 帮助按钮）
        const helpBtn = document.getElementById('vc-input-help-btn');
        const inputText = document.getElementById('vc-input-text');
        
        // 独立绑定帮助按钮
        if (helpBtn) {
            helpBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showToast('括号()用来描述画面/环境音，点击头像可触发回复');
            });
        }

        if (inputText) {
            const sendHandler = () => {
                const text = inputText.value.trim();
                if (text) {
                    this.sendUserAction(text);
                    inputText.value = '';
                    inputText.focus(); // 发送后保持聚焦
                }
            };

            // 绑定回车发送
            inputText.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') sendHandler();
            });
            
            // 点击遮罩层关闭输入面板
            document.getElementById('vc-input-overlay').addEventListener('click', (e) => {
                if (e.target.id === 'vc-input-overlay') {
                    e.target.style.display = 'none';
                }
            });
        }

        // 新主卧输入浮层：点击外部区域收起
        const masterInputOverlay = document.getElementById('vc-master-input-overlay');
        const masterInput = document.getElementById('vc-master-input-text');
        if (masterInputOverlay && masterInput) {
            masterInputOverlay.addEventListener('click', (e) => {
                if (e.target === masterInputOverlay) {
                    masterInputOverlay.style.display = 'none';
                }
            });

            const sendFromMasterInput = () => {
                const panel = document.getElementById('vc-master-text-panel');
                if (!panel) return;
                const value = masterInput.value.trim();
                if (!value) return;

                this.appendVcMasterGlassLine(panel, value);

                panel.scrollTo({
                    top: panel.scrollHeight,
                    behavior: 'smooth'
                });

                masterInput.value = '';
            };

            masterInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendFromMasterInput();
                }
            });

        }

        // 绑定历史记录弹窗关闭按钮
        const historyCloseBtn = document.getElementById('vc-history-close-btn');
        if (historyCloseBtn) {
            historyCloseBtn.addEventListener('click', () => {
                document.getElementById('vc-history-modal').classList.remove('visible');
                setTimeout(() => {
                    document.getElementById('vc-history-modal').style.display = 'none';
                }, 300);
            });
        }

        // 绑定头像点击：返回新主卧的隐形传送门
        const avatarBtn = document.getElementById('vc-call-avatar');
        if (avatarBtn) {
            avatarBtn.addEventListener('click', () => this.showImmersiveSceneFromArchive());
        }

        // 绑定来电弹窗按钮
        const incomingAcceptBtn = document.getElementById('vc-incoming-accept-btn');
        if (incomingAcceptBtn) {
            incomingAcceptBtn.addEventListener('click', () => {
                // 用户点击“接听”来电：在同步栈中预先解锁苹果音频通道
                if (typeof TTSModule !== 'undefined' && typeof TTSModule.unlockAppleAudio === 'function') {
                    TTSModule.unlockAppleAudio();
                }
                this.acceptCall();
            });
        }

        const incomingRejectBtn = document.getElementById('vc-incoming-reject-btn');
        if (incomingRejectBtn) {
            incomingRejectBtn.addEventListener('click', () => this.rejectCall());
        }

        this.initMasterScratchFloat();
    },

    // --- 悬浮窗逻辑 ---

    minimizeCall: function() {
        if (!this.state.isCallActive) return;
        
        this.state.isMinimized = true;
        
        // 隐藏全屏界面
        const callScene = document.getElementById('vc-scene-call');
        callScene.classList.add('vc-hidden');
        callScene.style.display = 'none';
        
        // 显示悬浮窗
        const floatWindow = document.getElementById('vc-floating-window');
        const floatAvatar = document.getElementById('vc-float-avatar');
        
        // 同步头像
        if (this.state.currentChat) {
            const avatarUrl = this.state.currentChat.avatar || 'https://i.postimg.cc/1zsGZ85M/Camera_1040g3k831o3b7f1bkq105oaltnigkev8gp3kia8.jpg';
            floatAvatar.style.backgroundImage = `url('${avatarUrl}')`;
        }
        
        floatWindow.style.display = 'block';
        
        // 恢复到底层页面（隐藏全屏层后自然露出底层页面）
    },

    maximizeCall: function() {
        if (!this.state.isCallActive) return;
        
        // 检查是否需要切换回对应的聊天窗口
        if (this.state.currentChat && typeof currentChatId !== 'undefined') {
            if (currentChatId !== this.state.currentChat.id) {
                // 需要切换聊天
                if (typeof openChatRoom === 'function') {
                    // 假设 currentChatType 可以从 currentChat 对象推断，或者在 startCall 时记录
                    // 这里简单尝试推断：如果有 members 则是群聊，否则是私聊
                    let type = 'private';
                    if (this.state.currentChat.members) type = 'group';
                    
                    openChatRoom(this.state.currentChat.id, type);
                }
            }
        }

        this.state.isMinimized = false;
        
        // 隐藏悬浮窗
        const floatWindow = document.getElementById('vc-floating-window');
        floatWindow.style.display = 'none';
        
        // 显示全屏界面
        const callScene = document.getElementById('vc-scene-call');
        callScene.style.display = 'flex';
        callScene.classList.remove('vc-hidden');
        callScene.style.opacity = 1;
    },

    initDraggable: function(el) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;
        let hasMoved = false;

        const onStart = (e) => {
            if (e.target.closest('.vc-minimize-btn')) return; // 忽略按钮点击
            
            isDragging = true;
            hasMoved = false;
            el.style.transition = 'none';
            
            const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
            const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
            
            startX = clientX;
            startY = clientY;
            
            const rect = el.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            
            // 转换为 fixed 定位的 left/top（移除 right/bottom 影响）
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.left = initialLeft + 'px';
            el.style.top = initialTop + 'px';
        };

        const onMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            
            const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
            const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
            
            const dx = clientX - startX;
            const dy = clientY - startY;
            
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
            
            el.style.left = (initialLeft + dx) + 'px';
            el.style.top = (initialTop + dy) + 'px';
        };

        const onEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            el.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
            
            // 标记是否发生了拖拽，用于区分点击事件
            el.dataset.isDragging = hasMoved ? 'true' : 'false';
            setTimeout(() => el.dataset.isDragging = 'false', 100);

            // 吸附边缘逻辑
            const rect = el.getBoundingClientRect();
            const winWidth = window.innerWidth;
            const winHeight = window.innerHeight;
            
            let targetLeft = rect.left;
            let targetTop = rect.top;
            
            // 左右吸附
            if (rect.left + rect.width / 2 < winWidth / 2) {
                targetLeft = 10; // 吸附到左边距
            } else {
                targetLeft = winWidth - rect.width - 10; // 吸附到右边距
            }
            
            // 上下限制
            if (targetTop < 60) targetTop = 60; // 避开顶栏
            if (targetTop > winHeight - rect.height - 80) targetTop = winHeight - rect.height - 80; // 避开底栏
            
            el.style.left = targetLeft + 'px';
            el.style.top = targetTop + 'px';
        };

        el.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        
        el.addEventListener('touchstart', onStart, {passive: false});
        document.addEventListener('touchmove', onMove, {passive: false});
        document.addEventListener('touchend', onEnd);
    },

    /**
     * 新主卧：进入全局画中画（pip-mode），底层可切换其他页面。
     */
    enterMasterPip: function() {
        if (!this.state.isCallActive) return;
        const master = document.getElementById('vc-scene-master');
        if (!master || master.classList.contains('vc-hidden')) return;

        const overlay = document.getElementById('vc-master-input-overlay');
        const input = document.getElementById('vc-master-input-text');
        if (overlay) overlay.style.display = 'none';
        if (input) input.blur();

        master.classList.add('pip-mode');
        master.style.left = '';
        master.style.top = '';
        master.style.right = '';
        master.style.bottom = '';
        master.style.transform = '';
        master.style.willChange = '';
        const pipHandle = this.ensureMasterPipDragHandle(master);
        pipHandle.style.display = 'block';
        this.state.isMasterPip = true;
        this.updateCameraPreviewVisibility();
    },

    exitMasterPip: function() {
        const master = document.getElementById('vc-scene-master');
        if (!master || !master.classList.contains('pip-mode')) {
            this.state.isMasterPip = false;
            return;
        }
        master.classList.remove('pip-mode');
        master.style.left = '';
        master.style.top = '';
        master.style.right = '';
        master.style.bottom = '';
        master.style.width = '';
        master.style.height = '';
        master.style.transition = '';
        master.style.transform = '';
        master.style.willChange = '';
        const h = master.querySelector('.vc-master-pip-drag-handle');
        if (h) h.style.display = 'none';
        this.state.isMasterPip = false;
        this.updateCameraPreviewVisibility();
    },

    ensureMasterPipDragHandle: function(master) {
        let el = master.querySelector('.vc-master-pip-drag-handle');
        if (!el) {
            el = document.createElement('div');
            el.className = 'vc-master-pip-drag-handle';
            el.style.display = 'none';
            master.appendChild(el);
        }
        return el;
    },

    /**
     * 画中画：透明拖拽层接收按下；move 在 document 上跟手（移出小窗仍有效）。
     */
    initMasterPipInteraction: function() {
        const master = document.getElementById('vc-scene-master');
        if (!master || master.dataset.vcPipBound === '1') return;
        master.dataset.vcPipBound = '1';

        const handle = this.ensureMasterPipDragHandle(master);

        const self = this;
        let dragging = false;
        let startX, startY, initialLeft, initialTop;
        let pipDragW = 0;
        let pipDragH = 0;
        let moved = false;

        const arm = (clientX, clientY) => {
            const rect = master.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            startX = clientX;
            startY = clientY;
            pipDragW = master.offsetWidth;
            pipDragH = master.offsetHeight;
            master.style.transition = 'none';
            master.style.right = 'auto';
            master.style.bottom = 'auto';
            master.style.left = `${initialLeft}px`;
            master.style.top = `${initialTop}px`;
            master.style.transform = 'translate3d(0,0,0)';
            master.style.willChange = 'transform';
        };

        const dragTo = (clientX, clientY) => {
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
            const w = pipDragW;
            const h = pipDragH;
            const marginX = 25;
            const marginBottom = 25;
            const marginTop = 62;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const minL = marginX;
            const maxL = Math.max(minL, vw - w - marginX);
            const minT = marginTop;
            const maxT = Math.max(minT, vh - h - marginBottom);
            let left = initialLeft + dx;
            let top = initialTop + dy;
            left = Math.min(Math.max(minL, left), maxL);
            top = Math.min(Math.max(minT, top), maxT);
            const tx = left - initialLeft;
            const ty = top - initialTop;
            master.style.transform = `translate3d(${tx}px,${ty}px,0)`;
        };

        const finish = () => {
            if (!dragging) return;
            dragging = false;
            master.style.transition = '';
            master.style.willChange = '';
            if (moved && master.classList.contains('pip-mode')) {
                const r = master.getBoundingClientRect();
                master.style.left = `${r.left}px`;
                master.style.top = `${r.top}px`;
                master.style.transform = '';
            }
            if (!moved && master.classList.contains('pip-mode')) {
                self.exitMasterPip();
            }
        };

        handle.addEventListener('touchstart', (e) => {
            if (!master.classList.contains('pip-mode')) return;
            dragging = true;
            moved = false;
            const t = e.touches[0];
            if (!t) return;
            arm(t.clientX, t.clientY);
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!dragging || !master.classList.contains('pip-mode')) return;
            const t = e.touches[0];
            if (!t) return;
            e.preventDefault();
            dragTo(t.clientX, t.clientY);
        }, { passive: false });

        document.addEventListener('touchend', finish);
        document.addEventListener('touchcancel', finish);

        handle.addEventListener('mousedown', (e) => {
            if (!master.classList.contains('pip-mode')) return;
            if (e.button !== 0) return;
            dragging = true;
            moved = false;
            arm(e.clientX, e.clientY);
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging || !master.classList.contains('pip-mode')) return;
            dragTo(e.clientX, e.clientY);
        });

        document.addEventListener('mouseup', finish);
    },

    isVideoCallMode: function() {
        return this.state.callType === 'video';
    },

    getFloatingSafeBounds: function(width, height) {
        const marginX = 25;
        const marginBottom = 25;
        const marginTop = 62;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        return {
            minLeft: marginX,
            maxLeft: Math.max(marginX, vw - width - marginX),
            minTop: marginTop,
            maxTop: Math.max(marginTop, vh - height - marginBottom)
        };
    },

    clampFloatingPosition: function(left, top, width, height) {
        const bounds = this.getFloatingSafeBounds(width, height);
        return {
            left: Math.min(Math.max(bounds.minLeft, left), bounds.maxLeft),
            top: Math.min(Math.max(bounds.minTop, top), bounds.maxTop)
        };
    },

    initCallCameraControls: function() {
        this.ensureCameraPreviewElements();
        this.bindCameraControlButton(document.getElementById('vc-camera-toggle-btn'));
        this.bindCameraControlButton(document.getElementById('vc-master-camera-btn'));
        this.syncCameraUiState();
    },

    bindCameraControlButton: function(button) {
        if (!button || button.dataset.vcCameraBound === '1') return;
        button.dataset.vcCameraBound = '1';

        const LONG_PRESS_MS = 550;
        const MOVE_THRESHOLD_SQ = 100;
        let activePointerId = null;
        let pressTimer = null;
        let longPressTriggered = false;
        let startX = 0;
        let startY = 0;

        const clearTimer = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        const cleanup = () => {
            clearTimer();
            if (activePointerId != null) {
                try {
                    button.releasePointerCapture(activePointerId);
                } catch (_) { /* ignore */ }
            }
            activePointerId = null;
        };

        button.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            activePointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            longPressTriggered = false;
            clearTimer();
            pressTimer = setTimeout(() => {
                pressTimer = null;
                longPressTriggered = true;
                void this.handleCameraLongPress();
            }, LONG_PRESS_MS);
            try {
                button.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        });

        button.addEventListener('pointermove', (e) => {
            if (e.pointerId !== activePointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (dx * dx + dy * dy > MOVE_THRESHOLD_SQ) {
                clearTimer();
            }
        });

        button.addEventListener('pointerup', (e) => {
            if (e.pointerId !== activePointerId) return;
            const shouldToggle = !longPressTriggered && !!pressTimer;
            cleanup();
            if (shouldToggle) {
                void this.handleCameraShortTap();
            }
        });

        button.addEventListener('pointercancel', (e) => {
            if (e.pointerId !== activePointerId) return;
            cleanup();
        });
    },

    handleCameraShortTap: async function() {
        if (!this.isVideoCallMode()) return;
        const enabled = await this.toggleCallCamera();
        if (enabled == null) return;
        showToast(enabled ? '摄像头已开启' : '摄像头已关闭');
    },

    handleCameraLongPress: async function() {
        if (!this.isVideoCallMode()) return;
        await this.runCameraBurstSend();
    },

    ensureMasterVideoBackdrop: function() {
        const masterScene = document.getElementById('vc-scene-master');
        if (!masterScene) return null;

        let layer = document.getElementById('vc-master-live-video-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.id = 'vc-master-live-video-layer';
            layer.className = 'vc-master-live-video-layer';
            layer.innerHTML = '<video id="vc-master-live-video" class="vc-master-live-video" autoplay playsinline muted></video>';
            const overlay = masterScene.querySelector('.vc-master-overlay');
            if (overlay) {
                masterScene.insertBefore(layer, overlay);
            } else {
                masterScene.appendChild(layer);
            }
        }
        return layer;
    },

    ensureCameraPreviewElements: function() {
        let host = document.getElementById('vc-camera-preview-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'vc-camera-preview-host';
            host.className = 'vc-camera-preview-host';
            host.innerHTML = `
                <div id="vc-camera-preview-photo" class="vc-camera-preview-photo"></div>
                <video id="vc-camera-preview-video" class="vc-camera-preview-video" autoplay playsinline muted></video>
                <button type="button" id="vc-camera-flip-btn" class="vc-camera-flip-btn" aria-label="翻转镜头">前/后</button>
            `;
            document.body.appendChild(host);
        }

        if (host.dataset.vcPreviewBound !== '1') {
            host.dataset.vcPreviewBound = '1';
            const flipBtn = document.getElementById('vc-camera-flip-btn');
            if (flipBtn) {
                flipBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void this.flipCallCamera();
                });
            }
            host.addEventListener('click', (e) => {
                if (e.target.closest('.vc-camera-flip-btn')) return;
                if (host.dataset.dragMoved === '1') return;
                void this.toggleCameraSwapMode();
            });
            this.initCameraPreviewDrag(host);
        }

        return host;
    },

    initCameraPreviewDrag: function(host) {
        if (!host || host.dataset.vcDragBound === '1') return;
        host.dataset.vcDragBound = '1';

        let pointerId = null;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;
        let previewW = 0;
        let previewH = 0;
        let moved = false;

        host.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.vc-camera-flip-btn')) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;

            const rect = host.getBoundingClientRect();
            host.style.right = 'auto';
            host.style.bottom = 'auto';
            host.style.left = `${rect.left}px`;
            host.style.top = `${rect.top}px`;
            host.style.transform = 'translate3d(0,0,0)';
            host.style.transition = 'none';
            host.style.willChange = 'transform';

            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            originLeft = rect.left;
            originTop = rect.top;
            previewW = host.offsetWidth;
            previewH = host.offsetHeight;
            moved = false;
            host.dataset.dragMoved = '0';

            try {
                host.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        });

        host.addEventListener('pointermove', (e) => {
            if (e.pointerId !== pointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
            const next = this.clampFloatingPosition(
                originLeft + dx,
                originTop + dy,
                previewW,
                previewH
            );
            const tx = next.left - originLeft;
            const ty = next.top - originTop;
            host.style.transform = `translate3d(${tx}px,${ty}px,0)`;
        });

        const finish = (e) => {
            if (e.pointerId !== pointerId) return;
            try {
                host.releasePointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
            pointerId = null;
            host.style.transition = '';
            host.style.willChange = '';
            if (moved) {
                const r = host.getBoundingClientRect();
                host.style.left = `${r.left}px`;
                host.style.top = `${r.top}px`;
            }
            host.style.transform = '';
            host.dataset.dragMoved = moved ? '1' : '0';
            setTimeout(() => {
                host.dataset.dragMoved = '0';
            }, 80);
        };

        host.addEventListener('pointerup', finish);
        host.addEventListener('pointercancel', finish);
    },

    syncCameraSurfaceContent: function() {
        const host = this.ensureCameraPreviewElements();
        const previewVideo = document.getElementById('vc-camera-preview-video');
        const previewPhoto = document.getElementById('vc-camera-preview-photo');
        const liveLayer = this.ensureMasterVideoBackdrop();
        const liveVideo = document.getElementById('vc-master-live-video');
        const bgUrl = this.state.callBackground;
        const mirrorTransform = this.state.cameraFacingMode === 'user' ? 'scaleX(-1)' : 'none';

        if (previewPhoto) {
            previewPhoto.style.backgroundImage = bgUrl ? `url('${bgUrl}')` : '';
        }

        if (previewVideo) {
            previewVideo.style.transform = mirrorTransform;
            if (previewVideo.srcObject !== this.state.cameraStream) {
                previewVideo.srcObject = this.state.cameraStream || null;
            }
        }

        if (liveVideo) {
            liveVideo.style.transform = mirrorTransform;
            if (liveVideo.srcObject !== this.state.cameraStream) {
                liveVideo.srcObject = this.state.cameraStream || null;
            }
        }

        if (host) {
            host.classList.toggle('is-photo-mode', !!this.state.cameraSwapActive);
        }
        if (liveLayer) {
            liveLayer.classList.toggle('is-visible', !!this.state.cameraSwapActive && !!this.state.cameraStream && this.state.isCallActive && this.isVideoCallMode());
        }
    },

    remountScratchFloatAnchorIfVisible: function() {
        const root = document.getElementById('vc-scratch-float-root');
        const btn = document.getElementById('vc-scratch-float-btn');
        if (!root || !btn) return;
        const master = document.getElementById('vc-scene-master');
        if (!master || master.classList.contains('vc-hidden')) return;
        const mStyle = getComputedStyle(master);
        if (mStyle.display === 'none' || mStyle.visibility === 'hidden') return;

        const br = btn.getBoundingClientRect();
        if (br.width === 0 || br.height === 0) return;
        const rr = root.getBoundingClientRect();
        if (rr.width === 0 || rr.height === 0) return;

        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        btn.style.left = `${br.left - rr.left}px`;
        btn.style.top = `${br.top - rr.top}px`;
        btn.dataset.vcScratchLaidOut = '1';
    },

    syncCameraUiState: function() {
        const isActive = this.state.cameraEnabled && this.state.isCallActive && this.isVideoCallMode();
        const isDisabledMode = this.state.isCallActive && !this.isVideoCallMode();
        const markup = isActive ? CAMERA_ON_SVG : CAMERA_OFF_SVG;

        const legacyIcon = document.querySelector('#vc-camera-toggle-btn .vc-c-icon-box');
        if (legacyIcon) legacyIcon.innerHTML = markup;

        const masterIcon = document.querySelector('#vc-master-camera-btn .vc-master-icon');
        if (masterIcon) masterIcon.innerHTML = markup;

        const legacyBtn = document.getElementById('vc-camera-toggle-btn');
        const masterBtn = document.getElementById('vc-master-camera-btn');
        if (legacyBtn) legacyBtn.classList.toggle('is-disabled', isDisabledMode);
        if (masterBtn) masterBtn.classList.toggle('is-disabled', isDisabledMode);

        this.updateCameraPreviewVisibility();
    },

    updateCameraPreviewVisibility: function() {
        const host = this.ensureCameraPreviewElements();
        const shouldShow = this.state.cameraEnabled && this.state.isCallActive && this.isVideoCallMode() && !this.state.isMasterPip;
        if (host) {
            host.classList.toggle('is-visible', shouldShow);
        }
        this.syncCameraSurfaceContent();
    },

    startCallCameraStream: async function(targetFacingMode) {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            showToast('当前环境不支持摄像头');
            return false;
        }

        const requestedFacingMode = targetFacingMode || this.state.cameraFacingMode || 'user';
        const constraints = {
            audio: false,
            video: {
                facingMode: { ideal: requestedFacingMode }
            }
        };

        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            } catch (fallbackError) {
                console.error('摄像头开启失败:', error, fallbackError);
                showToast('无法打开摄像头');
                return false;
            }
        }

        if (this.state.cameraStream) {
            this.state.cameraStream.getTracks().forEach(track => track.stop());
        }

        this.state.cameraStream = stream;
        this.state.cameraFacingMode = requestedFacingMode;
        this.state.cameraEnabled = true;

        const video = document.getElementById('vc-camera-preview-video');
        if (video) {
            video.srcObject = stream;
            try {
                await video.play();
            } catch (_) { /* ignore autoplay rejection */ }
        }

        this.syncCameraUiState();
        return true;
    },

    stopCallCameraStream: function() {
        if (this.state.cameraStream) {
            this.state.cameraStream.getTracks().forEach(track => track.stop());
        }
        this.state.cameraStream = null;
        this.state.cameraEnabled = false;
        this.state.cameraSwapActive = false;
        const video = document.getElementById('vc-camera-preview-video');
        if (video) {
            video.pause();
            video.srcObject = null;
        }
        const liveVideo = document.getElementById('vc-master-live-video');
        if (liveVideo) {
            liveVideo.pause();
            liveVideo.srcObject = null;
        }
        this.syncCameraUiState();
    },

    toggleCallCamera: async function() {
        if (!this.isVideoCallMode()) return null;
        if (this.state.cameraEnabled) {
            this.stopCallCameraStream();
            return false;
        }
        return this.startCallCameraStream(this.state.cameraFacingMode || 'user');
    },

    flipCallCamera: async function() {
        if (!this.isVideoCallMode() || !this.state.cameraEnabled) return;
        const nextFacingMode = this.state.cameraFacingMode === 'environment' ? 'user' : 'environment';
        const started = await this.startCallCameraStream(nextFacingMode);
        if (started) {
            showToast(nextFacingMode === 'environment' ? '已切换后置镜头' : '已切换前置镜头');
        }
    },

    toggleCameraSwapMode: async function() {
        if (!this.isVideoCallMode() || !this.state.isCallActive) return;
        if (!this.state.cameraEnabled || !this.state.cameraStream) return;
        this.state.cameraSwapActive = !this.state.cameraSwapActive;
        this.syncCameraSurfaceContent();
    },

    ensureCameraReadyForVision: async function() {
        if (!this.isVideoCallMode()) return false;
        if (this.state.cameraEnabled && this.state.cameraStream) return true;
        const opened = await this.startCallCameraStream(this.state.cameraFacingMode || 'user');
        if (opened) {
            showToast('摄像头已开启');
        }
        return opened;
    },

    captureCameraFrame: async function() {
        if (!this.state.cameraEnabled) return null;
        const video = document.getElementById('vc-camera-preview-video');
        if (!video) return null;

        if (video.readyState < 2) {
            await new Promise(resolve => setTimeout(resolve, 180));
        }

        const width = video.videoWidth || 720;
        const height = video.videoHeight || 1280;
        if (!width || !height) return null;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
        canvas.width = 1;
        canvas.height = 1;
        return {
            dataUrl,
            capturedAt: Date.now()
        };
    },

    destroyEphemeralVisionFrames: function(frames) {
        if (!Array.isArray(frames)) return;
        frames.forEach(frame => {
            if (frame) {
                frame.dataUrl = '';
                frame.capturedAt = 0;
            }
        });
        frames.length = 0;
    },

    getGlassPanelSubmissionTexts: function() {
        const panel = document.getElementById('vc-master-text-panel');
        return {
            panel,
            texts: this.getVcMasterGlassLineTexts(panel)
        };
    },

    commitGlassTextsToCallContext: async function(texts) {
        for (let i = 0; i < texts.length; i++) {
            await this.sendUserAction(texts[i]);
        }
    },

    getRealtimeVisionSystemPrompt: function() {
        return '[系统警告：以下是用户当前视频通话的实时画面截帧。请当作你正隔着屏幕看着用户，绝对禁止在回复中使用“发来的照片”、“自拍”、“图片”、“照片”等词汇，必须维持实时视频通话的互动语境！]';
    },

    getVisionOnlyTransientUserText: function() {
        const chat = this.state.currentChat || {};
        const myName = chat.myName || (chat.me ? chat.me.nickname : '我');
        return `[${myName}的画面/环境音：我正处在与你的实时视频通话里，请直接根据此刻镜头中的我与现场环境继续回应。]`;
    },

    clearForegroundCallDraftUi: function() {
        const masterInput = document.getElementById('vc-master-input-text');
        const archiveInput = document.getElementById('vc-input-text');
        const masterInputOverlay = document.getElementById('vc-master-input-overlay');
        const archiveInputOverlay = document.getElementById('vc-input-overlay');
        const panel = document.getElementById('vc-master-text-panel');

        if (masterInput) masterInput.value = '';
        if (archiveInput) archiveInput.value = '';
        if (masterInputOverlay) masterInputOverlay.style.display = 'none';
        if (archiveInputOverlay) archiveInputOverlay.style.display = 'none';
        if (panel) panel.innerHTML = '';
    },

    /* 获取左上角胶片计数器 DOM 元素 */
    getFilmCounter: function() {
        return document.getElementById('vc-film-counter');
    },

    /* 显示左上角胶片计数器，切换为倒计时或进度样式 */
    setFilmCounterText: function(text, mode) {
        const el = this.getFilmCounter();
        if (!el) return;
        const textEl = el.querySelector('.vc-film-counter-text');
        if (!textEl) return;
        textEl.textContent = text;
        textEl.className = 'vc-film-counter-text';
        if (mode === 'countdown') textEl.classList.add('is-countdown');
        else if (mode === 'progress') textEl.classList.add('is-progress');
        el.classList.add('is-visible');
    },

    hideFilmCounter: function() {
        const el = this.getFilmCounter();
        if (el) el.classList.remove('is-visible');
    },

    showFilmRollBtn: function() {
        const btn = document.getElementById('vc-film-roll-btn');
        if (btn) btn.classList.add('is-visible');
    },

    hideFilmRollBtn: function() {
        const btn = document.getElementById('vc-film-roll-btn');
        if (btn) btn.classList.remove('is-visible');
    },

    /* 左上角：先显示 3→2→1 倒计时，完成后 resolve(true) */
    showFilmCountdown: function() {
        this.state.cameraCountdownActive = true;
        const labels = ['3', '2', '1'];
        this.setFilmCounterText(labels[0], 'countdown');

        return new Promise(resolve => {
            let index = 0;
            const tick = () => {
                if (!this.state.isCallActive || !this.state.cameraCountdownActive) {
                    this.hideFilmCounter();
                    resolve(false);
                    return;
                }
                index += 1;
                if (index < labels.length) {
                    this.setFilmCounterText(labels[index], 'countdown');
                    setTimeout(tick, 1000);
                    return;
                }
                setTimeout(() => resolve(true), 120);
            };
            setTimeout(tick, 1000);
        });
    },

    /* 主流程：长按 Camera → 倒计时 → 12张慢速连拍 → 显示胶片入口 */
    runCameraBurstSend: async function() {
        if (this.isSystemBusy()) {
            showToast('正在说话，请稍后操作。');
            return;
        }
        if (this.state.cameraBurstInProgress || this.state.scratchAwaitingAi) {
            showToast('正在回复中，请稍后');
            return;
        }
        if (!this.state.isCallActive || !this.isVideoCallMode()) return;

        const ready = await this.ensureCameraReadyForVision();
        if (!ready) return;

        /* ── 强制清场：销毁旧胶卷、清空选中、隐藏胶片入口，保证左上角绝对干净 ── */
        this.destroyEphemeralVisionFrames(this.state.filmRollFrames);
        this._filmSelectedSet = new Set();
        this.hideFilmRollBtn();
        this.closeFilmAlbum(true);

        this.state.cameraBurstInProgress = true;
        const TOTAL = 12;
        const INTERVAL_MS = 1500;
        const capturedFrames = [];

        try {
            /* 阶段一：3-2-1 倒计时 */
            const countdownOk = await this.showFilmCountdown();
            if (!countdownOk || !this.state.isCallActive) return;

            /* 阶段二：连续抓拍 12 张，每张 1.5s */
            for (let i = 0; i < TOTAL; i++) {
                if (!this.state.isCallActive || !this.state.cameraBurstInProgress) break;
                this.setFilmCounterText(`${i + 1}/${TOTAL}`, 'progress');
                const frame = await this.captureCameraFrame();
                if (frame) capturedFrames.push(frame);
                if (i < TOTAL - 1) {
                    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
                }
            }

            /* 阶段三：隐藏计数器，显示胶片入口 */
            this.hideFilmCounter();
            if (capturedFrames.length > 0) {
                this.state.filmRollFrames = capturedFrames;
                this.showFilmRollBtn();
            }
        } finally {
            this.state.cameraBurstInProgress = false;
            this.state.cameraCountdownActive = false;
            this.hideFilmCounter();
        }
    },

    /**
     * 新主卧玻璃板：按 DOM 行顺序取出每条纯文本，不拼接，与档案室气泡 1:1 对应。
     */
    getVcMasterGlassLineTexts: function(panel) {
        if (!panel) return [];
        const lines = panel.querySelectorAll('.vc-master-text-line');
        if (lines.length > 0) {
            return Array.from(lines)
                .map((el) => el.textContent.trim())
                .filter(Boolean);
        }
        const t = panel.textContent.trim();
        return t ? [t] : [];
    },

    /* =============================================
       胶片相册面板 & 大图预览
       ============================================= */

    /* 打开相册面板，渲染 filmRollFrames 缩略图 */
    openFilmAlbum: function() {
        const frames = this.state.filmRollFrames;
        if (!frames || frames.length === 0) return;

        const overlay = document.getElementById('vc-film-album-overlay');
        const grid = document.getElementById('vc-film-album-grid');
        if (!overlay || !grid) return;

        /* 默认全不选 */
        this._filmSelectedSet = new Set();
        grid.innerHTML = '';

        frames.forEach((frame, idx) => {
            const item = document.createElement('div');
            item.className = 'vc-film-thumb-item';
            item.dataset.idx = idx;

            const img = document.createElement('img');
            img.src = frame.dataUrl;
            img.alt = `照片 ${idx + 1}`;
            img.draggable = false;
            item.appendChild(img);

            const check = document.createElement('div');
            check.className = 'vc-film-thumb-check';
            item.appendChild(check);

            /* 所有交互统一由 item 接管 */
            item.addEventListener('click', (e) => {
                if (item.dataset.longPressed === '1') { item.dataset.longPressed = '0'; return; }
                if (e.target.closest('.vc-film-thumb-check')) {
                    if (this._filmSelectedSet.has(idx)) {
                        this._filmSelectedSet.delete(idx);
                    } else {
                        this._filmSelectedSet.add(idx);
                    }
                    this._syncAlbumSelection();
                    return;
                }
                this.openFilmPreview(idx);
            });

            let lpTimer = null;
            item.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.vc-film-thumb-check')) return;
                lpTimer = setTimeout(() => {
                    item.dataset.longPressed = '1';
                    this.openFilmPreview(idx);
                }, 400);
            });
            const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
            item.addEventListener('pointerup', cancelLp);
            item.addEventListener('pointercancel', cancelLp);

            grid.appendChild(item);
        });

        this._syncAlbumSelection();
        overlay.classList.add('is-visible');

        /* 绑定关闭按钮 */
        const closeBtn = document.getElementById('vc-film-album-close-btn');
        if (closeBtn && !closeBtn.dataset.bound) {
            closeBtn.dataset.bound = '1';
            closeBtn.addEventListener('click', () => this.closeFilmAlbum(false));
        }

        /* 背景点击关闭 */
        if (!overlay.dataset.bound) {
            overlay.dataset.bound = '1';
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) this.closeFilmAlbum(false);
            });
        }

        /* 全选/取消全选 */
        const selAllBtn = document.getElementById('vc-film-select-all-btn');
        if (selAllBtn && !selAllBtn.dataset.bound) {
            selAllBtn.dataset.bound = '1';
            selAllBtn.addEventListener('click', () => {
                const frames = this.state.filmRollFrames;
                if (this._filmSelectedSet.size === frames.length) {
                    this._filmSelectedSet.clear();
                } else {
                    frames.forEach((_, i) => this._filmSelectedSet.add(i));
                }
                this._syncAlbumSelection();
            });
        }

        /* 发送按钮 */
        const sendBtn = document.getElementById('vc-film-send-btn');
        if (sendBtn && !sendBtn.dataset.bound) {
            sendBtn.dataset.bound = '1';
            sendBtn.addEventListener('click', () => this.submitFilmSelection());
        }
    },

    /* 同步相册网格的勾选外观 */
    _syncAlbumSelection: function() {
        const grid = document.getElementById('vc-film-album-grid');
        if (!grid) return;
        const frames = this.state.filmRollFrames;
        grid.querySelectorAll('.vc-film-thumb-item').forEach(item => {
            const idx = parseInt(item.dataset.idx, 10);
            const selected = this._filmSelectedSet.has(idx);
            item.classList.toggle('is-selected', selected);
        });
        const sendBtn = document.getElementById('vc-film-send-btn');
        if (sendBtn) sendBtn.disabled = this._filmSelectedSet.size === 0;
        const selAllBtn = document.getElementById('vc-film-select-all-btn');
        if (selAllBtn) {
            selAllBtn.textContent = this._filmSelectedSet.size === frames.length ? '取消全选' : '全选';
        }
    },

    /* 关闭相册面板 */
    closeFilmAlbum: function(silent) {
        const overlay = document.getElementById('vc-film-album-overlay');
        if (overlay) overlay.classList.remove('is-visible');
        this.closeFilmPreview();
    },

    /* 打开大图预览 */
    openFilmPreview: function(startIdx) {
        const frames = this.state.filmRollFrames;
        if (!frames || frames.length === 0) return;

        const overlay = document.getElementById('vc-film-preview-overlay');
        const slides = document.getElementById('vc-film-preview-slides');
        const indexEl = document.getElementById('vc-film-preview-index');
        const checkBtn = document.getElementById('vc-film-preview-check-btn');
        const track = document.getElementById('vc-film-preview-track');
        if (!overlay || !slides || !track) return;

        /* 渲染所有幻灯片 */
        slides.innerHTML = '';
        frames.forEach((frame, idx) => {
            const slide = document.createElement('div');
            slide.className = 'vc-film-preview-slide';
            const img = document.createElement('img');
            img.src = frame.dataUrl;
            img.alt = `照片 ${idx + 1}`;
            img.draggable = false;
            slide.appendChild(img);
            slides.appendChild(slide);
        });

        this._previewCurrentIdx = startIdx;
        this._updatePreviewView(false);

        overlay.classList.add('is-visible');

        /* 关闭按钮 */
        const closeBtn = document.getElementById('vc-film-preview-close');
        if (closeBtn && !closeBtn.dataset.bound) {
            closeBtn.dataset.bound = '1';
            closeBtn.addEventListener('click', () => this.closeFilmPreview());
        }

        /* 勾选按钮 */
        if (checkBtn && !checkBtn.dataset.bound) {
            checkBtn.dataset.bound = '1';
            checkBtn.addEventListener('click', () => {
                const idx = this._previewCurrentIdx;
                if (this._filmSelectedSet.has(idx)) {
                    this._filmSelectedSet.delete(idx);
                } else {
                    this._filmSelectedSet.add(idx);
                }
                this._updatePreviewView(false);
                this._syncAlbumSelection();
            });
        }

        /* 左右滑动手势 */
        if (!track.dataset.swipeBound) {
            track.dataset.swipeBound = '1';
            let startX = 0;
            let startY = 0;
            let activePointerId = null;
            let isVerticalLocked = false;
            let dragDeltaX = 0;
            const W = () => track.offsetWidth || window.innerWidth;

            track.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                activePointerId = e.pointerId;
                startX = e.clientX;
                startY = e.clientY;
                isVerticalLocked = false;
                dragDeltaX = 0;
                slides.style.transition = 'none';
                try { track.setPointerCapture(e.pointerId); } catch(_) {}
            });

            track.addEventListener('pointermove', (e) => {
                if (activePointerId === null || e.pointerId !== activePointerId) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                /* 始终记录水平位移，供 finish 判断 */
                dragDeltaX = dx;
                /* 若纵向分量显著大于横向则锁定为竖向滚动，停止跟随渲染 */
                if (Math.abs(dy) > Math.abs(dx) + 12) {
                    isVerticalLocked = true;
                    return;
                }
                if (isVerticalLocked) return;
                const baseOffset = -this._previewCurrentIdx * W();
                slides.style.transform = `translateX(${baseOffset + dx}px)`;
            });

            const finish = (e) => {
                if (activePointerId === null || e.pointerId !== activePointerId) return;
                const localDelta = dragDeltaX;
                const wasVertical = isVerticalLocked;
                activePointerId = null;
                isVerticalLocked = false;
                dragDeltaX = 0;
                try { track.releasePointerCapture(e.pointerId); } catch(_) {}

                const totalFrames = this.state.filmRollFrames.length;
                if (!wasVertical) {
                    const threshold = W() * 0.22;
                    if (localDelta < -threshold && this._previewCurrentIdx < totalFrames - 1) {
                        this._previewCurrentIdx++;
                    } else if (localDelta > threshold && this._previewCurrentIdx > 0) {
                        this._previewCurrentIdx--;
                    }
                }
                this._updatePreviewView(true);
            };
            track.addEventListener('pointerup', finish);
            track.addEventListener('pointercancel', finish);
        }
    },

    /* 更新大图预览当前帧显示 */
    _updatePreviewView: function(animated) {
        const slides = document.getElementById('vc-film-preview-slides');
        const indexEl = document.getElementById('vc-film-preview-index');
        const checkBtn = document.getElementById('vc-film-preview-check-btn');
        const track = document.getElementById('vc-film-preview-track');
        if (!slides || !track) return;

        const idx = this._previewCurrentIdx;
        const total = this.state.filmRollFrames.length;
        const W = track.offsetWidth || window.innerWidth;

        slides.style.transition = animated ? 'transform 0.28s cubic-bezier(0.4,0,0.2,1)' : 'none';
        slides.style.transform = `translateX(${-idx * W}px)`;

        if (indexEl) indexEl.textContent = `${idx + 1} / ${total}`;
        if (checkBtn) {
            const selected = this._filmSelectedSet && this._filmSelectedSet.has(idx);
            checkBtn.classList.toggle('is-checked', !!selected);
        }
    },

    /* 关闭大图预览 */
    closeFilmPreview: function() {
        const overlay = document.getElementById('vc-film-preview-overlay');
        if (overlay) overlay.classList.remove('is-visible');
    },

    /* 确认发送选中照片 */
    submitFilmSelection: async function() {
        if (!this._filmSelectedSet || this._filmSelectedSet.size === 0) {
            showToast('请至少选择一张照片');
            return;
        }
        if (this.isSystemBusy() || this.state.scratchAwaitingAi || this.state.cameraBurstInProgress) {
            showToast('正在回复中，请稍后');
            return;
        }

        const overlay = document.getElementById('vc-master-input-overlay');
        const input = document.getElementById('vc-master-input-text');
        if (overlay) overlay.style.display = 'none';
        if (input) input.blur();

        const allFrames = this.state.filmRollFrames;
        const selectedFrames = Array.from(this._filmSelectedSet)
            .sort((a, b) => a - b)
            .map(i => allFrames[i])
            .filter(Boolean);

        if (selectedFrames.length === 0) return;

        /* 关闭面板 */
        this.closeFilmAlbum(false);
        this.hideFilmRollBtn();

        /* 读取玻璃板文本 */
        const { panel, texts } = this.getGlassPanelSubmissionTexts();

        this.state.scratchAwaitingAi = true;
        this.startCameraRipples();
        try {
            if (texts.length) {
                await this.commitGlassTextsToCallContext(texts);
                if (panel) panel.innerHTML = '';
            }

            await this.triggerAiReply({
                visionFrames: selectedFrames,
                visionRoute: 'camera-hold',
                extraSystemPrompt: this.getRealtimeVisionSystemPrompt(),
                transientUserText: texts.length ? '' : this.getVisionOnlyTransientUserText()
            });
        } finally {
            this.stopCameraRipples();
            this.state.scratchAwaitingAi = false;
            /* 绝密扫尾：销毁所有缓存帧并隐藏胶片入口 */
            this.destroyEphemeralVisionFrames(this.state.filmRollFrames);
            this._filmSelectedSet = new Set();
        }
    },

    /* Camera 按钮水波纹：独立参数，严格锁死扩散半径，不干扰邻近按钮 */
    startCameraRipples: function() {
        const btn = document.getElementById('vc-master-camera-btn');
        if (!btn) return;
        this.stopCameraRipples();

        /* 确保宿主层存在 */
        let host = btn.querySelector('.vc-camera-ripple-host');
        if (!host) {
            host = document.createElement('span');
            host.className = 'vc-camera-ripple-host';
            btn.appendChild(host);
        }

        this.state.cameraRippleActive = true;
        const self = this;
        const DURATION_MS = 1400;
        const DELAYS_SEC = [0, 0.5];
        const lastEndMs = Math.round(DELAYS_SEC[DELAYS_SEC.length - 1] * 1000) + DURATION_MS;

        const spawnBurst = () => {
            if (!self.state.cameraRippleActive || !host.isConnected) return;
            for (let i = 0; i < DELAYS_SEC.length; i++) {
                const ring = document.createElement('span');
                ring.className = 'vc-camera-ripple-ring';
                ring.style.animationDelay = `${DELAYS_SEC[i]}s`;
                host.appendChild(ring);
                ring.addEventListener('animationend', () => {
                    if (ring.parentNode) ring.remove();
                }, { once: true });
            }
            const gapMs = 400 + Math.random() * 200;
            self.state.cameraRippleTimeoutId = setTimeout(() => {
                self.state.cameraRippleTimeoutId = null;
                if (!self.state.cameraRippleActive || !host.isConnected) return;
                spawnBurst();
            }, lastEndMs + gapMs);
        };

        spawnBurst();
    },

    stopCameraRipples: function() {
        this.state.cameraRippleActive = false;
        if (this.state.cameraRippleTimeoutId != null) {
            clearTimeout(this.state.cameraRippleTimeoutId);
            this.state.cameraRippleTimeoutId = null;
        }
        const btn = document.getElementById('vc-master-camera-btn');
        const host = btn && btn.querySelector('.vc-camera-ripple-host');
        if (host) host.innerHTML = '';
    },

    /**
     * 新主卧玻璃板单行：英文 () 与中文（）内片段用 span 斜体灰显，仅 createTextNode/安全文本，防 XSS。
     */
    appendVcMasterGlassLine: function(panel, rawText) {
        if (!panel || rawText == null) return;
        const line = document.createElement('div');
        line.className = 'vc-master-text-line';
        const frag = document.createDocumentFragment();
        const re = /(\([^)]*\)|（[^）]*）)/g;
        let last = 0;
        let m;
        while ((m = re.exec(rawText)) !== null) {
            if (m.index > last) {
                frag.appendChild(document.createTextNode(rawText.slice(last, m.index)));
            }
            const span = document.createElement('span');
            span.className = 'vc-master-paren-aside';
            span.textContent = m[1];
            frag.appendChild(span);
            last = re.lastIndex;
        }
        if (last < rawText.length) {
            frag.appendChild(document.createTextNode(rawText.slice(last)));
        }
        line.appendChild(frag);
        panel.appendChild(line);
    },

    stopScratchBreathingRipples: function(btn) {
        this.state.scratchBreathingActive = false;
        if (this.state.scratchBreathTimeoutId != null) {
            clearTimeout(this.state.scratchBreathTimeoutId);
            this.state.scratchBreathTimeoutId = null;
        }
        const host = btn && btn.querySelector('.vc-scratch-float-ripple-host');
        if (host) host.innerHTML = '';
    },

    startScratchBreathingRipples: function(btn) {
        const host = btn && btn.querySelector('.vc-scratch-float-ripple-host');
        if (!host) return;
        this.stopScratchBreathingRipples(btn);
        this.state.scratchBreathingActive = true;
        const self = this;
        const RIPPLE_DURATION_MS = 1800;
        const RING_DELAYS_SEC = [0, 0.6];
        const lastRingEndMs =
            Math.round(RING_DELAYS_SEC[RING_DELAYS_SEC.length - 1] * 1000) + RIPPLE_DURATION_MS;

        const spawnBurst = () => {
            if (!self.state.scratchBreathingActive || !host.isConnected) return;
            for (let i = 0; i < RING_DELAYS_SEC.length; i++) {
                const ring = document.createElement('span');
                ring.className = 'vc-scratch-float-ripple-ring';
                ring.style.animationDelay = `${RING_DELAYS_SEC[i]}s`;
                host.appendChild(ring);
                ring.addEventListener(
                    'animationend',
                    () => {
                        if (ring.parentNode) ring.remove();
                    },
                    { once: true }
                );
            }
            const gapMs = 500 + Math.random() * 300;
            self.state.scratchBreathTimeoutId = setTimeout(() => {
                self.state.scratchBreathTimeoutId = null;
                if (!self.state.scratchBreathingActive || !host.isConnected) return;
                spawnBurst();
            }, lastRingEndMs + gapMs);
        };

        spawnBurst();
    },

    runScratchTextOnlySend: async function(btn) {
        const btnEl = btn || document.getElementById('vc-scratch-float-btn');
        if (this.isSystemBusy()) {
            showToast('正在说话，请稍后操作。');
            return;
        }
        if (this.state.scratchAwaitingAi) {
            showToast('正在回复中，请稍后');
            return;
        }

        if (!this.state.isCallActive) {
            return;
        }

        const panel = document.getElementById('vc-master-text-panel');
        const glassLineTexts = this.getVcMasterGlassLineTexts(panel);
        const hasGlassText = glassLineTexts.length > 0;

        if (!hasGlassText) {
            showToast('右侧玻璃板还没有文字');
            return;
        }

        this.state.scratchAwaitingAi = true;
        try {
            for (let i = 0; i < glassLineTexts.length; i++) {
                await this.sendUserAction(glassLineTexts[i]);
            }

            if (panel) panel.innerHTML = '';

            if (typeof getCallReply !== 'function') {
                showToast('通话回复模块未加载');
                return;
            }

            this.startScratchBreathingRipples(btnEl);
            try {
                await this.triggerAiReply();
            } finally {
                this.stopScratchBreathingRipples(btnEl);
            }
        } finally {
            this.state.scratchAwaitingAi = false;
            this.stopScratchBreathingRipples(btnEl);
        }
    },

    runScratchSnapshotSend: async function(btn) {
        const btnEl = btn || document.getElementById('vc-scratch-float-btn');
        if (this.isSystemBusy()) {
            showToast('正在说话，请稍后操作。');
            return;
        }
        if (this.state.scratchAwaitingAi || this.state.cameraBurstInProgress) {
            showToast('正在回复中，请稍后');
            return;
        }
        if (!this.state.isCallActive) return;

        const { panel, texts } = this.getGlassPanelSubmissionTexts();

        const ready = await this.ensureCameraReadyForVision();
        if (!ready) return;

        this.state.scratchAwaitingAi = true;
        const frames = [];
        try {
            this.startScratchBreathingRipples(btnEl);
            const frame = await this.captureCameraFrame();
            if (!frame) {
                showToast('快照失败，请重试');
                return;
            }
            frames.push(frame);

            if (texts.length) {
                await this.commitGlassTextsToCallContext(texts);
                if (panel) panel.innerHTML = '';
            }

            await this.triggerAiReply({
                visionFrames: frames,
                visionRoute: 'scratch-tap',
                extraSystemPrompt: this.getRealtimeVisionSystemPrompt(),
                transientUserText: texts.length ? '' : this.getVisionOnlyTransientUserText()
            });
        } finally {
            this.destroyEphemeralVisionFrames(frames);
            this.state.scratchAwaitingAi = false;
            this.stopScratchBreathingRipples(btnEl);
        }
    },

    runScratchFloatSend: async function(btn) {
        if (this.isSystemBusy()) {
            showToast('正在说话，请稍后操作。');
            return;
        }
        const overlay = document.getElementById('vc-master-input-overlay');
        const input = document.getElementById('vc-master-input-text');
        if (overlay) overlay.style.display = 'none';
        if (input) input.blur();
        if (this.isVideoCallMode()) {
            await this.runScratchSnapshotSend(btn);
            return;
        }
        await this.runScratchTextOnlySend(btn);
    },

    initMasterScratchFloat: function() {
        const root = document.getElementById('vc-scratch-float-root');
        const btn = document.getElementById('vc-scratch-float-btn');
        if (!root || !btn || btn.dataset.vcScratchBound === '1') return;
        btn.dataset.vcScratchBound = '1';

        const DRAG_THRESHOLD = 10;
        let activePointerId = null;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;
        let maxOffsetSq = 0;

        const ensureLeftTopFromComputed = () => {
            if (btn.dataset.vcScratchLaidOut === '1') return true;
            const master = document.getElementById('vc-scene-master');
            if (!master || master.classList.contains('vc-hidden')) return false;
            const mStyle = getComputedStyle(master);
            if (mStyle.display === 'none' || mStyle.visibility === 'hidden') return false;

            const br = btn.getBoundingClientRect();
            if (br.width === 0 || br.height === 0) return false;
            const rr = root.getBoundingClientRect();
            if (rr.width === 0 || rr.height === 0) return false;

            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
            btn.style.left = `${br.left - rr.left}px`;
            btn.style.top = `${br.top - rr.top}px`;
            btn.dataset.vcScratchLaidOut = '1';
            return true;
        };

        const clampPos = (l, t) => {
            const pad = 6;
            const bw = btn.offsetWidth || 54;
            const bh = btn.offsetHeight || 54;
            const rw = root.clientWidth;
            const rh = root.clientHeight;
            return {
                left: Math.min(Math.max(pad, l), Math.max(pad, rw - bw - pad)),
                top: Math.min(Math.max(pad, t), Math.max(pad, rh - bh - pad))
            };
        };

        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            activePointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            maxOffsetSq = 0;
            ensureLeftTopFromComputed();
            const rr = root.getBoundingClientRect();
            const br = btn.getBoundingClientRect();
            originLeft = br.left - rr.left;
            originTop = br.top - rr.top;
            btn.style.transition = 'none';
            try {
                btn.setPointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        });

        btn.addEventListener('pointermove', (e) => {
            if (e.pointerId !== activePointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            maxOffsetSq = Math.max(maxOffsetSq, dx * dx + dy * dy);
            if (maxOffsetSq < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
            const next = clampPos(originLeft + dx, originTop + dy);
            btn.style.left = `${next.left}px`;
            btn.style.top = `${next.top}px`;
        });

        btn.addEventListener('pointerup', (e) => {
            if (e.pointerId !== activePointerId) return;
            try {
                btn.releasePointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
            activePointerId = null;
            const wasDrag = maxOffsetSq >= DRAG_THRESHOLD * DRAG_THRESHOLD;
            if (!wasDrag) {
                if (typeof TTSModule !== 'undefined' && typeof TTSModule.unlockAppleAudio === 'function') {
                    TTSModule.unlockAppleAudio();
                }
                void this.runScratchFloatSend(btn);
            }
        });

        btn.addEventListener('pointercancel', (e) => {
            if (e.pointerId !== activePointerId) return;
            try {
                btn.releasePointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
            activePointerId = null;
        });
    },

    showCallTypeModal: function() {
        if (!currentChatId) {
            showToast('请先进入一个聊天室');
            return;
        }
        
        // 动态构建极简菜单
        const modal = document.getElementById('vc-type-modal');
        const sheet = modal.querySelector('.vc-type-sheet');
        
        // 重写内容为极简风格
        sheet.innerHTML = `
            <div class="vc-type-group">
                <button class="vc-type-btn" id="vc-start-video-btn-new">视频通话</button>
                <button class="vc-type-btn" id="vc-start-voice-btn-new">语音通话</button>
                <button class="vc-type-btn" id="vc-history-btn-new">通话记录</button>
            </div>
            <button class="vc-type-cancel" id="vc-type-cancel-btn">取消</button>
        `;
        
        // 重新绑定事件
        document.getElementById('vc-start-video-btn-new').addEventListener('click', () => this.startCall('video'));
        document.getElementById('vc-start-voice-btn-new').addEventListener('click', () => this.startCall('voice'));
        document.getElementById('vc-history-btn-new').addEventListener('click', () => {
            this.hideCallTypeModal();
            this.showHistoryModal();
        });
        document.getElementById('vc-type-cancel-btn').addEventListener('click', () => this.hideCallTypeModal());

        modal.style.display = 'flex';
        modal.offsetHeight; 
        modal.classList.add('visible');
    },

    hideCallTypeModal: function() {
        const modal = document.getElementById('vc-type-modal');
        modal.classList.remove('visible');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 300);
    },

    // 接收来电
    receiveCall: function(type, chatId) {
        let chat;
        if (chatId) {
            chat = db.characters.find(c => c.id === chatId);
            if (!chat) {
                chat = db.groups.find(g => g.id === chatId);
            }
        }
        
        if (!chat && typeof currentChatId !== 'undefined' && currentChatId) {
            if (currentChatType === 'private') {
                chat = db.characters.find(c => c.id === currentChatId);
            } else if (currentChatType === 'group') {
                chat = db.groups.find(g => g.id === currentChatId);
            }
        }

        if (!chat) return;
        
        this.state.incomingChat = chat;
        this.state.callType = type;

        const avatarUrl = chat.avatar || 'https://i.postimg.cc/1zsGZ85M/Camera_1040g3k831o3b7f1bkq105oaltnigkev8gp3kia8.jpg';
        const name = chat.remarkName || chat.name;
        const typeText = type === 'video' ? '邀请你进行视频通话...' : '邀请你进行语音通话...';

        document.getElementById('vc-incoming-avatar').style.backgroundImage = `url('${avatarUrl}')`;
        document.getElementById('vc-incoming-name').textContent = name;
        document.getElementById('vc-incoming-type').textContent = typeText;

        const modal = document.getElementById('vc-incoming-modal');
        modal.style.display = 'flex';
        modal.offsetHeight;
        modal.classList.add('visible');

        if (typeof playSound === 'function' && db.globalReceiveSound) {
            playSound(db.globalReceiveSound);
        }
    },

    acceptCall: function() {
        const modal = document.getElementById('vc-incoming-modal');
        modal.classList.remove('visible');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 300);

        const chat = this.state.incomingChat || this.state.currentChat;
        if (!chat) return;

        this.startCall(this.state.callType, true, chat);
        
        if (typeof currentChatId === 'undefined' || currentChatId !== chat.id) {
            if (typeof loadChat === 'function') {
                loadChat(chat.id);
            }
        }
    },

    rejectCall: async function() {
        const modal = document.getElementById('vc-incoming-modal');
        modal.classList.remove('visible');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 300);

        const chat = this.state.incomingChat || this.state.currentChat;

        if (chat) {
            const myName = chat.myName || (chat.me ? chat.me.nickname : '我');
            const targetName = chat.realName || chat.name;
            const typeText = this.state.callType === 'video' ? '视频' : '语音';

            const msg = {
                id: `msg_${Date.now()}`,
                role: 'system',
                content: `[${myName}拒绝了${targetName}的${typeText}通话]`,
                timestamp: Date.now()
            };
            chat.history.push(msg);
            await saveData();
            
            if (typeof renderMessages === 'function' && typeof currentChatId !== 'undefined' && currentChatId === chat.id) {
                renderMessages(false, true);
            }
        }
        
        this.state.incomingChat = null;
    },

    startCall: async function(type, isIncoming = false, chatObject = null) {
        if (typeof TTSModule !== 'undefined' && typeof TTSModule.unlockAppleAudio === 'function') {
            TTSModule.unlockAppleAudio();
        }
        this.hideCallTypeModal();
        this.clearForegroundCallDraftUi();
        this.state.cameraCountdownActive = false;
        this.state.cameraBurstInProgress = false;
        this.state.cameraSwapActive = false;
        this.destroyEphemeralVisionFrames(this.state.filmRollFrames);
        this._filmSelectedSet = new Set();
        this.stopCameraRipples();
        this.hideFilmCounter();
        this.hideFilmRollBtn();
        this.closeFilmAlbum(true);
        this.state.callType = type;
        this.state.isCallActive = true;
        this.state.seconds = 0;
        this.state.currentCallContext = [];
        this.state.startTime = Date.now();
        this.state.initialAiResponse = null;
        if (type !== 'video') {
            this.stopCallCameraStream();
        } else {
            this.syncCameraUiState();
        }

        let chat = chatObject;
        if (!chat) {
            if (currentChatType === 'private') {
                chat = db.characters.find(c => c.id === currentChatId);
            } else if (currentChatType === 'group') {
                chat = db.groups.find(g => g.id === currentChatId);
            }
        }

        if (!chat) {
            showToast('无法获取聊天对象信息');
            return;
        }
        this.state.currentChat = chat;
        // 记录专属通话背景（优先使用角色通话背景，其次聊天背景，最后全局壁纸）
        try {
            this.state.callBackground = (chat.callBg || chat.chatBg || db.wallpaper || null);
        } catch (e) {
            this.state.callBackground = null;
        }

        if (!isIncoming) {
            const myName = chat.myName || (chat.me ? chat.me.nickname : '我');
            const targetName = chat.realName || chat.name; 
            const typeText = type === 'video' ? '视频' : '语音';
            const inviteMsg = {
                id: `msg_${Date.now()}_${Math.random()}`,
                role: 'system',
                content: `[${myName}向${targetName}发起了${typeText}通话]`,
                timestamp: Date.now()
            };
            chat.history.push(inviteMsg);
            await saveData();
            if (typeof renderMessages === 'function') {
                renderMessages(false, true);
            }
        }

        const charAvatarUrl = chat.avatar || 'https://i.postimg.cc/1zsGZ85M/Camera_1040g3k831o3b7f1bkq105oaltnigkev8gp3kia8.jpg';
        
        // 动态获取用户头像（优先使用当前聊天室的设置）
        let userAvatarUrl = 'https://i.postimg.cc/3wCK3KpF/Camera_1040g3k031ltndl58ku105pq1g7e7dme715cc1go.jpg';
        
        if (currentChatType === 'private') {
            if (chat.myAvatar) {
                userAvatarUrl = chat.myAvatar;
            }
        } else if (currentChatType === 'group') {
            if (chat.me && chat.me.avatar) {
                userAvatarUrl = chat.me.avatar;
            }
        }

        document.getElementById('vc-loading-char-avatar').style.backgroundImage = `url('${charAvatarUrl}')`;
        document.getElementById('vc-loading-user-avatar').style.backgroundImage = `url('${userAvatarUrl}')`;
        
        // 更新加载界面名称
        const loadingNameEl = document.getElementById('vc-loading-char-name');
        if (loadingNameEl) {
            loadingNameEl.textContent = currentChatType === 'private' ? chat.remarkName : chat.name;
        }

        document.getElementById('vc-call-avatar').style.backgroundImage = `url('${charAvatarUrl}')`;
        document.getElementById('vc-call-name').textContent = currentChatType === 'private' ? chat.remarkName : chat.name;

        const loadingScene = document.getElementById('vc-scene-loading');
        loadingScene.classList.remove('vc-hidden');
        loadingScene.style.display = 'flex';
        loadingScene.style.opacity = 1;

        const aiPromise = this.fetchInitialAiResponse(chat, type, isIncoming);
        await this.runConnectionSequence(aiPromise, isIncoming);
    },

    fetchInitialAiResponse: async function(chat, type, isIncoming) {
        if (typeof getCallReply !== 'function') return null;
        
        let content = '';
        if (isIncoming) {
            content = type === 'video' ? '(我接通了你的视频通话请求)' : '(我接通了你的语音通话请求)';
        } else {
            content = type === 'video' ? '(我向你发起了视频通话，通话已接通)' : '(我向你发起了语音通话，通话已接通)';
        }

        const tempContext = [{
            role: 'user',
            content: content
        }];
        
        try {
            const response = await getCallReply(chat, type, tempContext, () => {});
            return response;
        } catch (e) {
            console.error("获取AI开场白失败:", e);
            return null;
        }
    },

    runConnectionSequence: async function(aiPromise, isIncoming) {
        const mainText = document.getElementById('vc-status-main');
        const subText = document.getElementById('vc-status-sub');
        
        if (!isIncoming) {
            if (!this.state.isCallActive) return;
            mainText.textContent = "正在连线中...";
            subText.textContent = "HANDSHAKE_INIT";
            mainText.style.opacity = 1;
            await new Promise(r => setTimeout(r, 1500));

            if (!this.state.isCallActive) return;
            mainText.style.opacity = 0;
            await new Promise(r => setTimeout(r, 200));
            mainText.textContent = "对方已收到邀请";
            subText.textContent = "WAITING_RESPONSE";
            mainText.style.opacity = 1;
            await new Promise(r => setTimeout(r, 1500));
        } else {
            mainText.textContent = "正在接通中...";
            subText.textContent = "CONNECTING...";
        }

        if (!this.state.isCallActive) return;
        mainText.style.opacity = 0;
        await new Promise(r => setTimeout(r, 200));
        mainText.textContent = "信号接通中...";
        subText.textContent = "SYNCING_PACKETS";
        mainText.style.opacity = 1;

        try {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 300000));
            const aiResponse = await Promise.race([aiPromise, timeoutPromise]);
            this.state.initialAiResponse = aiResponse;
        } catch (e) {
            console.warn("AI开场白等待超时或失败，将使用默认开场白", e);
        }

        if (!this.state.isCallActive) return;
        mainText.style.opacity = 0;
        await new Promise(r => setTimeout(r, 200));
        mainText.textContent = "连接成功";
        subText.textContent = "LINK_ESTABLISHED";
        mainText.style.color = "#34c759";
        mainText.style.opacity = 1;
        
        setTimeout(() => this.transitionToCallScene(), 800);
    },

    transitionToCallScene: function() {
        if (!this.state.isCallActive) return;

        const loadingScene = document.getElementById('vc-scene-loading');
        const callScene = document.getElementById('vc-scene-call');

        // 1. 仅准备“历史档案室”内容（清空聊天容器），不显示旧卧室，避免接通瞬间闪现
        const chatContainer = document.getElementById('vc-chat-container');
        if (chatContainer) {
            chatContainer.innerHTML = '';
        }
        // 旧卧室保持绝对隐藏，不设置 display: flex
        callScene.style.display = 'none';
        callScene.classList.add('vc-hidden');

        // 2. 硬切：立刻隐藏 loading，立刻显示新主卧（仅保留必要的 loading 结束延迟）
        setTimeout(() => {
            // 隐藏 loading 场景
            loadingScene.classList.add('vc-hidden');
            loadingScene.style.display = 'none';

            // 展示新主卧
            this.showImmersiveScene();

            if (typeof TTSModule !== 'undefined') {
                TTSModule.unlockCallAudio();
            }
            this.startTimer();
            this.sendInitialMessage();
        }, 500);
    },

    startTimer: function() {
        const timerEl = document.getElementById('vc-call-timer');
        const masterTimerEl = document.getElementById('vc-master-timer');
        const floatTimerEl = document.getElementById('vc-float-timer');
        
        this.state.seconds = 0;
        const updateTime = () => {
            const h = Math.floor(this.state.seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((this.state.seconds % 3600) / 60).toString().padStart(2, '0');
            const s = (this.state.seconds % 60).toString().padStart(2, '0');
            const timeStr = `${h}:${m}:${s}`;
            
            if (timerEl) timerEl.textContent = timeStr;
            if (masterTimerEl) masterTimerEl.textContent = timeStr;
            if (floatTimerEl) floatTimerEl.textContent = `${m}:${s}`; // 悬浮窗只显示分秒，节省空间
        };
        
        updateTime();
        
        this.state.timerInterval = setInterval(() => {
            this.state.seconds++;
            updateTime();
        }, 1000);
    },

    sendInitialMessage: function() {
        const chat = this.state.currentChat;
        const name = currentChatType === 'private' ? chat.remarkName : chat.name;
        
        if (this.state.initialAiResponse) {
            this.parseAndAddAiResponse(this.state.initialAiResponse);
            // 开场白整段推入 TTS 流（任务四）
            if (typeof TTSModule !== 'undefined') {
                TTSModule.feedCallChunk(this.state.initialAiResponse);
                TTSModule.flushCallBuffer();
            }
        } else {
            if (this.state.callType === 'video') {
                setTimeout(() => {
                    this.addMessage('ai', 'visual', `[ 镜头微微晃动，${name} 似乎正在调整角度 ]`);
                }, 500);
                setTimeout(() => {
                    const fallbackVideoText = `"……信号这下稳定了吗？让我看看你。"`;
                    this.addMessage('ai', 'voice', fallbackVideoText);
                    if (typeof TTSModule !== 'undefined') {
                        TTSModule.feedCallChunk(fallbackVideoText);
                        TTSModule.flushCallBuffer();
                    }
                }, 1500);
            } else {
                setTimeout(() => {
                    const fallbackVoiceText = `"喂？听得到吗？"`;
                    this.addMessage('ai', 'voice', fallbackVoiceText);
                    if (typeof TTSModule !== 'undefined') {
                        TTSModule.feedCallChunk(fallbackVoiceText);
                        TTSModule.flushCallBuffer();
                    }
                }, 1000);
            }
        }
    },


    parseAndAddAiResponse: function(fullText) {
        const regex = /\[(.*?)[：:]([\s\S]+?)\]/g;
        let match;
        let delay = 500;

        while ((match = regex.exec(fullText)) !== null) {
            const tag = match[1];
            let content = match[2];
            content = content.trim();
            
            let type = 'voice';
            if (tag.includes('画面') || tag.includes('环境') || tag.includes('动作')) {
                type = 'visual';
            }
            
            setTimeout(() => {
                this.addMessage('ai', type, content);
            }, delay);
            
            delay += 2000; 
        }
    },

    addMessage: function(who, type, content) {
        const container = document.getElementById('vc-chat-container');
        const msgDiv = document.createElement('div');
        msgDiv.className = `vc-msg-row ${who}`;
        
        // 存储索引以便后续操作
        const index = this.state.currentCallContext.length;
        msgDiv.dataset.index = index;

        if (type === 'visual') {
            msgDiv.innerHTML = `
                <div class="vc-deco-line"></div>
                <div class="vc-text-visual ${who}">${content}</div>
            `;
        } else {
            // --- 双语解析逻辑 ---
            let displayContent = content;
            let translation = null;
            
            // 尝试匹配双语格式：原文「译文」优先
            const bracketMatch = content.match(/^(.+?)「(.+?)」$/);
            if (bracketMatch) {
                displayContent = bracketMatch[1];
                translation = bracketMatch[2];
            } else {
                // 尝试匹配 () 或 （）
                const parenMatch = content.match(/^(.+?)[\(（](.+?)[\)）]$/);
                if (parenMatch) {
                    displayContent = parenMatch[1];
                    translation = parenMatch[2];
                }
            }

            if (translation) {
                msgDiv.innerHTML = `
                    <div class="vc-text-voice ${who}">
                        <span class="vc-voice-origin">${displayContent}</span>
                        <div class="vc-voice-trans">${translation}</div>
                    </div>
                `;
            } else {
                msgDiv.innerHTML = `
                    <div class="vc-text-voice ${who}">${content}</div>
                `;
            }
        }

        // 绑定隐形点击交互（visual 连读 / voice 单句）
        const visualEl = msgDiv.querySelector('.vc-text-visual');
        if (visualEl) {
            visualEl.addEventListener('click', () => this.handleVisualClick(index));
        }
        const voiceEl = msgDiv.querySelector('.vc-text-voice');
        if (voiceEl) {
            voiceEl.addEventListener('click', () => this.handleVoiceClick(index));
        }
        
        // 绑定长按事件
        let pressTimer;
        const startPress = (e) => {
            // 忽略多点触控
            if (e.touches && e.touches.length > 1) return;
            
            pressTimer = setTimeout(() => {
                if (typeof navigator.vibrate === 'function') navigator.vibrate(50);
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const clientY = e.touches ? e.touches[0].clientY : e.clientY;
                this.showContextMenu(clientX, clientY, index);
            }, 1000); // 1 秒长按
        };

        const cancelPress = () => {
            if (pressTimer) clearTimeout(pressTimer);
        };

        msgDiv.addEventListener('mousedown', startPress);
        msgDiv.addEventListener('touchstart', startPress, { passive: true });
        
        msgDiv.addEventListener('mouseup', cancelPress);
        msgDiv.addEventListener('mouseleave', cancelPress);
        msgDiv.addEventListener('touchend', cancelPress);
        msgDiv.addEventListener('touchmove', cancelPress);

        container.appendChild(msgDiv);
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });

        this.state.currentCallContext.push({
            role: who,
            type: type,
            content: content,
            timestamp: Date.now()
        });
    },

    // --- 通话内 TTS 隐形重听交互 ---

    handleVoiceClick: function(messageIndex) {
        if (!this.state.currentChat) return;
        const ctx = this.state.currentCallContext[messageIndex];
        if (!ctx || ctx.type !== 'voice') return;

        // 若通话自动朗读队列正在播放，暂不打断，避免破坏队列状态机
        if (typeof TTSModule !== 'undefined' &&
            TTSModule._state &&
            TTSModule._state.isCallStreamPlaying) {
            if (typeof showToast === 'function') {
                showToast('正在自动朗读中，请稍后再点击重听');
            }
            return;
        }

        // 再次点击同一条正在手动播放的 voice → 立即打断并重置
        if (this.state.manualPlayback &&
            this.state.manualPlayback.mode === 'voice' &&
            this.state.manualPlayback.voiceIndex === messageIndex &&
            this.state.manualPlayback.isPlaying) {
            if (typeof TTSModule !== 'undefined' && typeof TTSModule.stopCurrent === 'function') {
                TTSModule.stopCurrent();
            }
            this.setCinemaSubtitle('');
            this.state.manualPlayback = null;
            return;
        }

        // 切换到新的单句重听
        this.state.manualPlayback = {
            mode: 'voice',
            voiceIndex: messageIndex,
            isPlaying: true
        };

        this.playVoiceSentenceByIndex(messageIndex, () => {
            if (this.state.manualPlayback &&
                this.state.manualPlayback.mode === 'voice' &&
                this.state.manualPlayback.voiceIndex === messageIndex) {
                this.state.manualPlayback.isPlaying = false;
            }
        });
    },

    handleVisualClick: function(messageIndex) {
        if (!this.state.currentChat) return;

        // 若通话自动朗读队列正在播放，暂不打断
        if (typeof TTSModule !== 'undefined' &&
            TTSModule._state &&
            TTSModule._state.isCallStreamPlaying) {
            if (typeof showToast === 'function') {
                showToast('正在自动朗读中，请稍后再点击连读');
            }
            return;
        }

        const ctx = this.state.currentCallContext;
        const current = ctx[messageIndex];
        if (!current || current.type !== 'visual') return;

        // 再次点击同一 visual 且处于连读中 → 立即打断并重置
        if (this.state.manualPlayback &&
            this.state.manualPlayback.mode === 'visual' &&
            this.state.manualPlayback.visualIndex === messageIndex &&
            this.state.manualPlayback.isPlaying) {
            if (typeof TTSModule !== 'undefined' && typeof TTSModule.stopCurrent === 'function') {
                TTSModule.stopCurrent();
            }
            this.setCinemaSubtitle('');
            this.state.manualPlayback = null;
            return;
        }

        // 重新扫描该 visual 下方连续的 voice 句子，作为连读列表
        const voiceIndices = [];
        for (let i = messageIndex + 1; i < ctx.length; i++) {
            const item = ctx[i];
            if (!item) break;
            if (item.type === 'visual') break; // 遇到下一个 visual 即停止本段连读范围
            if (item.type === 'voice') {
                voiceIndices.push(i);
            }
        }
        if (voiceIndices.length === 0) return;

        // 启动新的连读：从第一句开始
        this.state.manualPlayback = {
            mode: 'visual',
            visualIndex: messageIndex,
            voiceIndices: voiceIndices,
            cursor: 0,
            isPlaying: true
        };

        this.playVisualSequence();
    },

    playVoiceSentenceByIndex: function(messageIndex, onEnded) {
        if (typeof TTSModule === 'undefined' || typeof TTSModule.playTextForCallSequence !== 'function') return;
        const ctx = this.state.currentCallContext[messageIndex];
        if (!ctx || ctx.type !== 'voice') return;

        const text = ctx.content;
        const chat = this.state.currentChat;

        // 使用与自动朗读完全一致的分句与入队规则进行重听，
        // playTextForCallSequence 内部会依次调用 playTextForCall 播放每一小段。
        TTSModule.playTextForCallSequence(text, chat, {
            onEndedAll: onEnded
        });
    },

    playVisualSequence: function() {
        if (!this.state.manualPlayback ||
            this.state.manualPlayback.mode !== 'visual' ||
            !Array.isArray(this.state.manualPlayback.voiceIndices)) {
            return;
        }

        const mp = this.state.manualPlayback;
        if (mp.cursor >= mp.voiceIndices.length) {
            this.state.manualPlayback = null;
            return;
        }

        const currentIndex = mp.voiceIndices[mp.cursor];
        mp.isPlaying = true;

        this.playVoiceSentenceByIndex(currentIndex, () => {
            // 如果在播放过程中用户点击了其他 visual/voice，manualPlayback 可能已被重置
            const currentMp = this.state.manualPlayback;
            if (!currentMp ||
                currentMp.mode !== 'visual' ||
                currentMp.visualIndex !== mp.visualIndex) {
                return;
            }

            currentMp.cursor += 1;
            if (currentMp.cursor >= currentMp.voiceIndices.length) {
                this.state.manualPlayback = null;
            } else {
                this.playVisualSequence();
            }
        });
    },

    showContextMenu: function(x, y, messageIndex) {
        // 移除已存在的菜单
        const existingMenu = document.getElementById('vc-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.id = 'vc-context-menu';
        menu.className = 'vc-context-menu';
        
        const regenerateBtn = document.createElement('div');
        regenerateBtn.className = 'vc-context-item';
        regenerateBtn.textContent = '重回';
        regenerateBtn.onclick = () => {
            this.handleRegenerate();
            menu.remove();
        };
        
        menu.appendChild(regenerateBtn);
        document.body.appendChild(menu);

        // 计算菜单位置（确保不溢出屏幕）
        const rect = menu.getBoundingClientRect();
        let top = y - rect.height - 10;
        let left = x - rect.width / 2;
        
        if (top < 10) top = y + 10;
        if (left < 10) left = 10;
        if (left + rect.width > window.innerWidth - 10) left = window.innerWidth - rect.width - 10;
        
        menu.style.top = top + 'px';
        menu.style.left = left + 'px';
        menu.classList.add('visible');

        // 点击外部关闭
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        // 延迟绑定以避免立即触发关闭
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    },

    handleRegenerate: function() {
        if (this.state.isGenerating) {
            showToast("正在生成中，请稍等...");
            return;
        }

        // 1. 找到最后一条 User 消息的索引
        let lastUserIndex = -1;
        for (let i = this.state.currentCallContext.length - 1; i >= 0; i--) {
            if (this.state.currentCallContext[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }

        // 如果没有 User 消息（例如刚开始），或者最后一条就是 User 消息（还没有 AI 回复），
        // 这种情况下“重回”可能意味着重新触发 AI 对开场白的回复，或者对最后一条 User 消息的回复。
        // 逻辑：删除 lastUserIndex 之后的所有 AI 消息。
        
        // 如果 lastUserIndex 为 -1（全是 AI 消息，比如只有开场白），则删除所有 AI 消息并重新获取开场白。
        // 也可以保留开场白；这里假定至少有一条 User 消息，或者我们希望重生成开场白。
        
        let startIndexToDelete = lastUserIndex + 1;
        
        // 如果最后一条就是 User 消息，说明没有 AI 回复可撤回，直接触发生成即可
        if (startIndexToDelete >= this.state.currentCallContext.length) {
            this.triggerAiReply();
            return;
        }

        // 2. 删除数据
        this.state.currentCallContext.splice(startIndexToDelete);

        // 3. 删除 DOM
        const container = document.getElementById('vc-chat-container');
        const msgs = container.querySelectorAll('.vc-msg-row');
        for (let i = startIndexToDelete; i < msgs.length; i++) {
            if (msgs[i]) msgs[i].remove();
        }

        // 4. 重新触发生成
        this.triggerAiReply();
    },

    triggerAiReply: async function(options = {}) {
        if (this.isSystemBusy()) {
            showToast(this.state.isGenerating ? '信号正在传输中...' : '对方正在说话...');
            return;
        }

        this.state.isGenerating = true;

        const avatar = document.getElementById('vc-call-avatar');

        if (avatar) {
            avatar.style.transform = "scale(0.95)";
            setTimeout(() => {
                avatar.style.transform = "scale(1)";
            }, 150);
        }

        try {
            if (typeof getCallReply === 'function') {
                let fullText = "";
                await getCallReply(this.state.currentChat, this.state.callType, this.state.currentCallContext, (chunk) => {
                    fullText += chunk;
                    // 档案室：流结束后 parseAndAddAiResponse(fullText) 落完整原文；TTS：feedCallChunk 内 _filterCallTextChunk 仅对白入队
                    if (typeof TTSModule !== 'undefined') {
                        TTSModule.feedCallChunk(chunk);
                    }
                }, options);

                // 流结束：将 buffer 中残余文字推入队列（任务四）
                if (typeof TTSModule !== 'undefined') {
                    TTSModule.flushCallBuffer();
                }

                if (fullText) {
                    this.parseAndAddAiResponse(fullText);
                }
            }
        } catch (e) {
            console.error("AI Reply Error:", e);
            showToast("信号连接失败");
        } finally {
            this.state.isGenerating = false;
        }
    },

    sendUserAction: async function(text) {
        if (!text) return;

        const parts = text.split(/([（\(].*?[）\)])/g);

        for (const part of parts) {
            if (!part.trim()) continue;

            const visualMatch = part.match(/^[（\(](.*?)[）\)]$/);
            
            if (visualMatch) {
                this.addMessage('user', 'visual', visualMatch[1].trim());
            } else {
                this.addMessage('user', 'voice', part.trim());
            }
        }
        
        if (!db.hasSeenVideoCallAvatarHint) {
            showToast("点击对话内容可重听语音，长按消息可重回");
            db.hasSeenVideoCallAvatarHint = true;
            saveData();
        }
    },

    endCall: async function(isLoading = false) {
        this.state.isCallActive = false;
        this.state.isMinimized = false;
        this.state.cameraCountdownActive = false;
        this.state.cameraBurstInProgress = false;
        this.state.cameraSwapActive = false;
        this.hideFilmCounter();
        this.hideFilmRollBtn();
        this.closeFilmAlbum(true);
        this.destroyEphemeralVisionFrames(this.state.filmRollFrames);
        this._filmSelectedSet = new Set();
        this.stopCameraRipples();

        // 通话结束：停止 TTS 并重置流式状态（任务四）
        if (typeof TTSModule !== 'undefined') {
            TTSModule.resetCallStream();
        }

        if (this.state.timerInterval) {
            clearInterval(this.state.timerInterval);
            this.state.timerInterval = null;
        }

        const loadingScene = document.getElementById('vc-scene-loading');
        const callScene = document.getElementById('vc-scene-call');
        const masterScene = document.getElementById('vc-scene-master');
        const floatWindow = document.getElementById('vc-floating-window');

        if (floatWindow) floatWindow.style.display = 'none';
        this.clearForegroundCallDraftUi();
        this.stopCallCameraStream();

        if (isLoading) {
            loadingScene.style.opacity = 0;
            setTimeout(() => {
                loadingScene.classList.add('vc-hidden');
                loadingScene.style.display = 'none';
            }, 500);
        } else {
            // 同时隐藏新主卧与旧卧室
            if (masterScene) {
                this.exitMasterPip();
                masterScene.style.opacity = 0;
                masterScene.classList.add('vc-hidden');
                masterScene.style.display = 'none';
            }
            callScene.style.opacity = 0;
            setTimeout(() => {
                callScene.classList.add('vc-hidden');
                callScene.style.display = 'none';
                callScene.style.opacity = 1;
            }, 500);
        }
        
        document.getElementById('vc-status-main').style.color = "rgba(255,255,255,0.9)";

        if (this.state.currentCallContext.length > 0) {
            const startTimeDate = new Date(this.state.startTime);
            const dateStr = `${startTimeDate.getFullYear()}/${startTimeDate.getMonth()+1}/${startTimeDate.getDate()} ${startTimeDate.getHours().toString().padStart(2,'0')}:${startTimeDate.getMinutes().toString().padStart(2,'0')}`;
            const durationStr = this.formatDuration(this.state.seconds);

            const callRecord = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                startTime: this.state.startTime,
                duration: this.state.seconds,
                type: this.state.callType,
                context: [...this.state.currentCallContext],
                summary: ""
            };

            if (!this.state.currentChat.callHistory) {
                this.state.currentChat.callHistory = [];
            }
            this.state.currentChat.callHistory.push(callRecord);

            const callTypeLabel = callRecord.type === 'voice' ? '语音' : '视频';
            
            const summaryMsg = {
                id: `msg_${Date.now()}_${Math.random()}`,
                role: 'system',
                content: `[${callTypeLabel}通话记录：${dateStr}；${durationStr}；]`, 
                timestamp: Date.now(),
                callRecordId: callRecord.id
            };
            this.state.currentChat.history.push(summaryMsg);

            await saveData();
            showToast('通话结束，正在生成总结...');
            
            if (typeof renderMessages === 'function' && currentChatId === this.state.currentChat.id) {
                renderMessages(false, true);
            }

            if (typeof generateCallSummary === 'function') {
                generateCallSummary(this.state.currentChat, this.state.currentCallContext).then(async (summary) => {
                    if (summary) {
                        callRecord.summary = summary;
                        const callTypeLabelInner = callRecord.type === 'voice' ? '语音' : '视频';
                        summaryMsg.content = `[${callTypeLabelInner}通话记录：${dateStr}；${durationStr}；${summary}]`;
                        
                        await saveData();
                        
                        if (typeof renderMessages === 'function' && currentChatId === this.state.currentChat.id) {
                            renderMessages(false, false);
                        }
                        showToast('通话总结已生成');
                    } else {
                        showToast('通话总结生成失败，可稍后重试');
                    }
                });
            }
        }
    },

    // --- 历史记录相关（重构版：iOS 风格 + 长按删除）---

    showHistoryModal: function() {
        if (!currentChatId) return;
        
        let chat;
        if (currentChatType === 'private') {
            chat = db.characters.find(c => c.id === currentChatId);
        } else if (currentChatType === 'group') {
            chat = db.groups.find(g => g.id === currentChatId);
        }

        if (!chat) return;
        this.state.currentChat = chat;

        const modal = document.getElementById('vc-history-modal');
        const listContainer = document.getElementById('vc-history-list');
        listContainer.innerHTML = '';

        const history = chat.callHistory || [];

        if (history.length === 0) {
            listContainer.innerHTML = '<div class="vc-history-empty">暂无通话记录</div>';
        } else {
            const sortedHistory = [...history].sort((a, b) => b.startTime - a.startTime);
            
            sortedHistory.forEach((record, index) => {
                const date = new Date(record.startTime);
                const now = new Date();
                let dateStr;
                if (date.toDateString() === now.toDateString()) {
                    dateStr = `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
                } else {
                    dateStr = `${date.getMonth()+1}/${date.getDate()}`;
                }
                
                const durationStr = this.formatDuration(record.duration);
                const typeIcon = record.type === 'video' ? 
                    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2V5z"/></svg>` : 
                    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.568 17.568 0 0 0 4.168 6.608 17.569 17.569 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.678.678 0 0 0-.58-.122l-2.19.547a1.745 1.745 0 0 1-1.657-.459L5.482 8.062a1.745 1.745 0 0 1-.46-1.657l.548-2.19a.678.678 0 0 0-.122-.58L3.654 1.328z"/></svg>`;
                
                const typeTitle = record.type === 'video' ? '视频通话' : '语音通话';
                const typeClass = record.type;

                // 创建容器
                const container = document.createElement('div');
                container.className = `vc-history-item-container ${typeClass}`;

                // 内容包裹容器
                const contentWrapper = document.createElement('div');
                contentWrapper.className = 'vc-history-content-wrapper';

                // 头部 (点击区域)
                const header = document.createElement('div');
                header.className = 'vc-history-header';
                header.innerHTML = `
                    <div class="vc-history-icon">${typeIcon}</div>
                    <div class="vc-history-info">
                        <div class="vc-history-title">${typeTitle}</div>
                        <div class="vc-history-subtitle">${durationStr}</div>
                    </div>
                    <div class="vc-history-right">
                        <div class="vc-history-date">${dateStr}</div>
                        <div class="vc-history-info-icon">i</div>
                    </div>
                `;

                // 详情区域 (默认折叠)
                const detail = document.createElement('div');
                detail.className = 'vc-history-detail';
                
                // 预先生成详情内容
                const detailContent = document.createElement('div');
                detailContent.className = 'vc-detail-content';
                
                // 1. 总结
                const generateBtnId = `vc-gen-summary-${record.id}`;
                const summaryText = record.summary || '';
                const btnText = record.summary ? '重新总结' : '生成总结';
                
                detailContent.innerHTML += `
                    <div class="vc-detail-summary" id="vc-summary-container-${record.id}">
                        <div class="vc-summary-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <div class="vc-summary-label" style="margin-bottom: 0;">通话总结</div>
                            <button class="vc-type-btn small" id="${generateBtnId}" style="margin: 0; width: auto; padding: 4px 12px; font-size: 12px;">${btnText}</button>
                        </div>
                        <div class="vc-summary-text" style="${summaryText ? '' : 'display:none;'}">${summaryText}</div>
                    </div>
                `;
                
                // 绑定生成事件
                setTimeout(() => {
                    const genBtn = document.getElementById(generateBtnId);
                    if (genBtn) {
                        genBtn.addEventListener('click', async (e) => {
                            e.stopPropagation(); // 防止触发折叠
                            
                            if (genBtn.disabled) return;
                            genBtn.disabled = true;
                            const originalText = genBtn.textContent;
                            genBtn.textContent = "生成中...";
                            
                            try {
                                if (typeof generateCallSummary === 'function') {
                                    const summary = await generateCallSummary(this.state.currentChat, record.context);
                                    
                                    if (summary) {
                                        // 1. 更新数据
                                        record.summary = summary;
                                        
                                        // 2. 更新聊天记录中的消息
                                        const chat = this.state.currentChat;
                                        const summaryMsg = chat.history.find(m => m.callRecordId === record.id);
                                        if (summaryMsg) {
                                            const date = new Date(record.startTime);
                                            const dateStr = `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
                                            const durationStr = this.formatDuration(record.duration);
                                            const callTypeLabelInner = record.type === 'voice' ? '语音' : '视频';
                                            summaryMsg.content = `[${callTypeLabelInner}通话记录：${dateStr}；${durationStr}；${summary}]`;
                                        }
                                        
                                        await saveData();
                                        
                                        // 3. 更新界面
                                        const container = document.getElementById(`vc-summary-container-${record.id}`);
                                        if (container) {
                                            const textEl = container.querySelector('.vc-summary-text');
                                            if (textEl) {
                                                textEl.textContent = summary;
                                                textEl.style.display = 'block';
                                            }
                                            
                                            // 更新按钮文本
                                            genBtn.textContent = "重新总结";
                                            
                                            // 重新计算高度
                                            const detail = container.closest('.vc-history-detail');
                                            if (detail && detail.style.height !== '0px') {
                                                detail.style.height = 'auto';
                                            }
                                        }
                                        
                                        showToast('通话总结已生成');
                                        
                                        // 4. 刷新聊天界面
                                        if (typeof renderMessages === 'function' && currentChatId === chat.id) {
                                            renderMessages(false, false);
                                        }
                                    } else {
                                        showToast('生成失败，请重试');
                                        genBtn.textContent = originalText;
                                    }
                                } else {
                                    showToast('生成功能不可用');
                                    genBtn.textContent = originalText;
                                }
                            } catch (err) {
                                console.error(err);
                                showToast('发生错误');
                                genBtn.textContent = originalText;
                            } finally {
                                genBtn.disabled = false;
                            }
                        });
                    }
                }, 0);

                // 2. 对话记录 (合并显示)
                let logHtml = '<div class="vc-detail-log">';
                if (record.context && record.context.length > 0) {
                    record.context.forEach(msg => {
                        const roleName = msg.role === 'ai' ? 'TA' : 'YOU';
                        const roleClass = msg.role;
                        
                        if (msg.type === 'visual') {
                            logHtml += `<span class="vc-log-line"><span class="vc-log-role ${roleClass}">${roleName}</span><span class="vc-log-visual">${msg.content}</span></span>`;
                        } else {
                            logHtml += `<span class="vc-log-line"><span class="vc-log-role ${roleClass}">${roleName}</span><span class="vc-log-text">${msg.content}</span></span>`;
                        }
                    });
                } else {
                    logHtml += '<span style="color:#999; font-style:italic;">无详细记录</span>';
                }
                logHtml += '</div>';
                
                detailContent.innerHTML += logHtml;
                detail.appendChild(detailContent);

                // 绑定点击事件 (展开/收起)
                header.addEventListener('click', () => {
                    const isExpanded = container.classList.contains('expanded');
                    if (isExpanded) {
                        // 收起
                        detail.style.height = detail.scrollHeight + 'px'; // 先设为具体高度
                        detail.offsetHeight; // 强制重绘
                        container.classList.remove('expanded');
                        detail.style.height = '0';
                        detail.style.overflow = 'hidden';
                    } else {
                        // 展开
                        container.classList.add('expanded');
                        detail.style.height = detailContent.scrollHeight + 'px';
                        
                        // 动画结束后设为 auto
                        const transitionEndHandler = () => {
                            if (container.classList.contains('expanded')) {
                                detail.style.height = 'auto';
                                detail.style.overflow = 'visible';
                            }
                            detail.removeEventListener('transitionend', transitionEndHandler);
                        };
                        detail.addEventListener('transitionend', transitionEndHandler);
                        // 兜底：防止 transitionend 未触发
                        setTimeout(() => {
                             if (container.classList.contains('expanded')) {
                                detail.style.height = 'auto';
                                detail.style.overflow = 'visible';
                            }
                        }, 350);
                    }
                });

                // 长按删除逻辑
                let pressTimer;
                const startPress = (e) => {
                    // 如果已展开，不触发长按（或者也可以触发，看需求，这里暂定不触发以免混淆）
                    // if (container.classList.contains('expanded')) return;
                    
                    pressTimer = setTimeout(() => {
                        if (typeof navigator.vibrate === 'function') navigator.vibrate(50);
                        this.showDeleteConfirm(record.id, container);
                    }, 600);
                };
                
                const cancelPress = () => {
                    if (pressTimer) clearTimeout(pressTimer);
                };

                header.addEventListener('touchstart', startPress, { passive: true });
                header.addEventListener('touchend', cancelPress);
                header.addEventListener('touchmove', cancelPress); // 滚动时取消长按

                contentWrapper.appendChild(header);
                contentWrapper.appendChild(detail);
                
                container.appendChild(contentWrapper);
                listContainer.appendChild(container);
            });
        }

        modal.style.display = 'flex';
        modal.offsetHeight;
        modal.classList.add('visible');
    },

    showDeleteConfirm: function(recordId, domElement) {
        // 复用 vc-type-modal 结构，但临时修改内容
        const modal = document.getElementById('vc-type-modal');
        const sheet = modal.querySelector('.vc-type-sheet');
        
        // 不需要真正备份原始内容，因为每次 showCallTypeModal 都会重写
        // 这里直接重写即可，后续再次打开时会由 showCallTypeModal 重新渲染
        
        sheet.innerHTML = `
            <div class="vc-type-group">
                <div class="vc-type-label" style="padding: 16px; text-align: center; font-size: 13px; color: #8e8e93; border-bottom: 1px solid rgba(0,0,0,0.1);">
                    确定要删除这条通话记录吗？
                </div>
                <button class="vc-type-btn" id="vc-confirm-delete-btn" style="color: #ff3b30; font-weight: 600;">删除记录</button>
            </div>
            <button class="vc-type-cancel" id="vc-cancel-delete-btn">取消</button>
        `;
        
        const deleteBtn = document.getElementById('vc-confirm-delete-btn');
        const cancelBtn = document.getElementById('vc-cancel-delete-btn');
        
        // 绑定事件
        const handleDelete = () => {
            this.deleteCallRecord(recordId, domElement);
            this.hideCallTypeModal(); // 关闭确认弹窗
        };
        
        const handleCancel = () => {
            this.hideCallTypeModal();
        };
        
        deleteBtn.onclick = handleDelete;
        cancelBtn.onclick = handleCancel;

        modal.style.display = 'flex';
        modal.offsetHeight; 
        modal.classList.add('visible');
    },

    deleteCallRecord: async function(recordId, domElement) {
        if (!this.state.currentChat) return;

        // 1. 从数据中移除
        const index = this.state.currentChat.callHistory.findIndex(r => r.id === recordId);
        if (index !== -1) {
            this.state.currentChat.callHistory.splice(index, 1);
            
            // 2. 尝试删除对应的聊天消息
            const msgIndex = this.state.currentChat.history.findIndex(m => m.callRecordId === recordId);
            if (msgIndex !== -1) {
                this.state.currentChat.history.splice(msgIndex, 1);
            }

            await saveData();
            
            // 3. 移除 DOM
            domElement.style.height = domElement.offsetHeight + 'px';
            domElement.style.transition = 'height 0.3s ease, opacity 0.3s ease';
            requestAnimationFrame(() => {
                domElement.style.height = '0';
                domElement.style.opacity = '0';
            });
            setTimeout(() => {
                domElement.remove();
                // 如果列表空了，显示提示
                const listContainer = document.getElementById('vc-history-list');
                if (listContainer.children.length === 0) {
                    listContainer.innerHTML = '<div class="vc-history-empty">暂无通话记录</div>';
                }
            }, 300);

            // 刷新聊天界面
            if (typeof renderMessages === 'function' && currentChatId === this.state.currentChat.id) {
                renderMessages(false, false);
            }
        }
    },

    formatDuration: function(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        if (m === 0) return `${s}秒`;
        return `${m}分${s}秒`;
    },

    /** 新主卧电影字幕（纯文本硬切，供 TTS 模块回调） */
    setCinemaSubtitle: function(text) {
        const el = document.getElementById('vc-master-cinema-subtitle');
        if (!el) return;
        const str = text == null ? '' : String(text);
        el.textContent = str;

        // 动态避让：重听状态 + 字幕非空时，玻璃板上抬；否则恢复原位
        const panel = document.getElementById('vc-master-text-panel');
        if (panel) {
            const shouldAvoid = str.length > 0 && !!this.state.manualPlayback;
            panel.classList.toggle('vc-text-panel-subtitle-avoid', shouldAvoid);
        }
    },

    // 新主卧：全屏沉浸式通话界面
    showImmersiveScene: function() {
        this.exitMasterPip();
        const masterScene = document.getElementById('vc-scene-master');
        if (!masterScene) return;

        const bgLayer = masterScene.querySelector('.vc-master-bg');
        const bgUrl = this.state.callBackground;
        if (bgLayer) {
            if (bgUrl) {
                bgLayer.style.backgroundImage = `url('${bgUrl}')`;
            } else {
                bgLayer.style.backgroundImage = '';
            }
        }

        // Camera 按钮始终保留，由运行时根据视频/语音模式决定是否响应
        const cameraBtn = document.getElementById('vc-master-camera-btn');
        if (cameraBtn) {
            cameraBtn.style.display = 'flex';
        }

        masterScene.style.display = 'flex';
        masterScene.classList.remove('vc-hidden');
        masterScene.style.opacity = 1;
        this.syncCameraSurfaceContent();
        this.syncCameraUiState();
        requestAnimationFrame(() => this.remountScratchFloatAnchorIfVisible());
    },

    hideImmersiveSceneToArchive: function() {
        const masterScene = document.getElementById('vc-scene-master');
        const callScene = document.getElementById('vc-scene-call');
        if (!masterScene || !callScene) return;

        this.exitMasterPip();

        // 硬切：新旧场景绝不同时可见
        // 1. 立刻隐藏新主卧
        masterScene.classList.add('vc-hidden');
        masterScene.style.display = 'none';

        // 2. 立刻显示历史档案室
        callScene.style.display = 'flex';
        callScene.classList.remove('vc-hidden');
    },

    // 从历史档案室返回新主卧（渐变动画）
    showImmersiveSceneFromArchive: function() {
        const masterScene = document.getElementById('vc-scene-master');
        const callScene = document.getElementById('vc-scene-call');
        if (!masterScene || !callScene) return;

        this.exitMasterPip();

        // 与 showImmersiveScene 一致：应用背景并同步 Camera 状态
        const bgLayer = masterScene.querySelector('.vc-master-bg');
        const bgUrl = this.state.callBackground;
        if (bgLayer) {
            bgLayer.style.backgroundImage = bgUrl ? `url('${bgUrl}')` : '';
        }
        const cameraBtn = document.getElementById('vc-master-camera-btn');
        if (cameraBtn) {
            cameraBtn.style.display = 'flex';
        }

        // 硬切：新旧场景绝不同时可见
        // 1. 立刻隐藏历史档案室
        callScene.classList.add('vc-hidden');
        callScene.style.display = 'none';

        // 2. 立刻显示新主卧
        masterScene.style.display = 'flex';
        masterScene.classList.remove('vc-hidden');
        this.syncCameraSurfaceContent();
        this.syncCameraUiState();
        requestAnimationFrame(() => this.remountScratchFloatAnchorIfVisible());
    }
};

// 导出全局变量
window.VideoCallModule = VideoCallModule;
