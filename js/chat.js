// --- 核心聊天逻辑 (js/chat.js) ---
// 此文件保留核心入口和胶水代码，具体功能已拆分至 js/modules/chat_*.js

/** 主输入框最多可视行数（超出部分在框内滚动） */
const MESSAGE_INPUT_MAX_LINES = 7;

/**
 * 按内容自动增高 #message-input（textarea），上限 MESSAGE_INPUT_MAX_LINES；侧栏按钮用 flex-end 贴底对齐。
 */
function syncMessageInputHeight() {
    const ta = typeof messageInput !== 'undefined' ? messageInput : document.getElementById('message-input');
    if (!ta || ta.tagName !== 'TEXTAREA') return;

    const minPx = 44;
    ta.style.height = 'auto';

    const cs = getComputedStyle(ta);
    let lineHeight = parseFloat(cs.lineHeight);
    if (!lineHeight || Number.isNaN(lineHeight)) {
        const fs = parseFloat(cs.fontSize) || 16;
        lineHeight = fs * 1.35;
    }
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxContentH = lineHeight * MESSAGE_INPUT_MAX_LINES + padY;

    const contentH = ta.scrollHeight;
    const nextH = Math.min(Math.max(contentH, minPx), maxContentH);
    ta.style.height = `${nextH}px`;
    ta.style.overflowY = contentH > maxContentH ? 'auto' : 'hidden';
}

function setupChatRoom() {
    const memoryJournalBtn = document.getElementById('memory-journal-btn');
    const deleteHistoryBtn = document.getElementById('delete-history-btn');
    const captureBtn = document.getElementById('capture-btn');
    const toggleExpansionBtn = document.getElementById('toggle-expansion-btn');
    const charStatusBtn = document.getElementById('char-status-btn');
    const statusOverlay = document.getElementById('char-status-overlay');
    const closeStatusBtn = document.getElementById('close-status-panel-btn');
    const statusContent = document.getElementById('char-status-content');

    if (charStatusBtn) {
        charStatusBtn.addEventListener('click', () => {
            const char = db.characters.find(c => c.id === currentChatId);
            if (!char || !char.statusPanel) return;

            statusContent.innerHTML = ''; // Clear previous content

            // Prepare data: combine history and current if needed
            let slidesData = [];
            if (char.statusPanel.history && char.statusPanel.history.length > 0) {
                // history is [newest, older, oldest...]
                // We want to display newest last (on the right), so history is on the left
                slidesData = [...char.statusPanel.history].reverse();
            } else if (char.statusPanel.currentStatusHtml) {
                slidesData = [{ html: char.statusPanel.currentStatusHtml, timestamp: Date.now() }];
            }

            if (slidesData.length === 0) {
                statusContent.innerHTML = '<p style="text-align:center; color:#999;">暂无状态信息</p>';
                statusOverlay.classList.add('visible');
                return;
            }

            // Build Swiper Structure
            const swiper = document.createElement('div');
            swiper.className = 'status-swiper';

            // Helper function for Lazy Loading
            const loadSlideContent = (index) => {
                if (index < 0 || index >= slidesData.length) return;
                const slide = swiper.children[index];
                if (!slide) return;
                const slideInner = slide.querySelector('.status-slide-inner');
                if (slideInner.hasChildNodes()) return; // Already loaded

                const item = slidesData[index];
                const htmlContent = item.html;
                if (htmlContent.includes('<!DOCTYPE html>') || htmlContent.includes('<html') || htmlContent.includes('<style')) {
                    const iframe = document.createElement('iframe');
                    iframe.style.cssText = "width: 100%; height: 100%; min-height: 80vh; border: none; background: transparent; display: block;";
                    iframe.srcdoc = processTemplate(htmlContent, char);
                    slideInner.appendChild(iframe);
                } else {
                    slideInner.innerHTML = processTemplate(htmlContent, char);
                }
            };

            // Create empty slides first
            slidesData.forEach((item, index) => {
                const slide = document.createElement('div');
                slide.className = 'status-slide';
                
                const slideInner = document.createElement('div');
                slideInner.className = 'status-slide-inner';
                // Content will be loaded lazily
                
                slide.appendChild(slideInner);
                swiper.appendChild(slide);
            });

            // Indicator
            const indicator = document.createElement('div');
            indicator.className = 'status-indicator';
            indicator.textContent = `${slidesData.length} / ${slidesData.length}`;

            statusContent.appendChild(swiper);
            statusContent.appendChild(indicator);

            // Initial Load: Load the last slide (newest) and previous ones
            const lastIndex = slidesData.length - 1;
            loadSlideContent(lastIndex);
            if (lastIndex > 0) loadSlideContent(lastIndex - 1);
            if (lastIndex > 1) loadSlideContent(lastIndex - 2);

            // Scroll to the end (newest) initially
            setTimeout(() => {
                swiper.style.scrollBehavior = 'auto';
                swiper.scrollLeft = swiper.scrollWidth;
                setTimeout(() => {
                    swiper.style.scrollBehavior = 'smooth';
                }, 50);
            }, 0);

            // Scroll Listener for Indicator & Lazy Loading
            swiper.addEventListener('scroll', () => {
                const width = swiper.offsetWidth;
                if (width > 0) {
                    const currentIndex = Math.round(swiper.scrollLeft / width);
                    indicator.textContent = `${currentIndex + 1} / ${slidesData.length}`;
                    
                    // Lazy load adjacent slides (current +/- 2)
                    for (let i = currentIndex - 2; i <= currentIndex + 2; i++) {
                        loadSlideContent(i);
                    }
                }
            });

            statusOverlay.classList.add('visible');
        });
    }

    if (closeStatusBtn) {
        closeStatusBtn.addEventListener('click', () => {
            statusOverlay.classList.remove('visible');
        });
    }
    
    if (statusOverlay) {
        statusOverlay.addEventListener('click', (e) => {
            if (e.target === statusOverlay) {
                statusOverlay.classList.remove('visible');
            }
        });
    }

    // 状态栏交互事件委托
    if (statusContent) {
        statusContent.addEventListener('click', (e) => {
            const target = e.target.closest('[data-send-msg]');
            if (target) {
                const msg = target.dataset.sendMsg;
                if (msg) {
                    const input = document.getElementById('message-input');
                    if (input) {
                        input.value = msg;
                        document.getElementById('send-message-btn').click();
                        // 关闭状态栏面板
                        statusOverlay.classList.remove('visible');
                    }
                }
            }
        });
    }

    if (toggleExpansionBtn) {
        toggleExpansionBtn.addEventListener('click', () => {
            if (chatExpansionPanel.classList.contains('visible') && panelFunctionArea.style.display !== 'none') {
                showPanel('none');
            } else {
                showPanel('function');
            }
        });
    }

    if (memoryJournalBtn) {
        memoryJournalBtn.addEventListener('click', () => {
            renderJournalList();
            switchScreen('memory-journal-screen');
            showPanel('none'); 
        });
    }

    if (deleteHistoryBtn) {
        deleteHistoryBtn.addEventListener('click', () => {
            openDeleteChunkModal();
            showPanel('none'); 
        });
    }

    if (captureBtn) {
        captureBtn.addEventListener('click', () => {
            enterMultiSelectMode(null, 'capture');
            showPanel('none');
        });
    }

    const shopBtn = document.getElementById('shop-btn');
    if (shopBtn) {
        shopBtn.addEventListener('click', () => {
            if (typeof openShopScreen === 'function') {
                openShopScreen();
                showPanel('none');
            } else {
                showToast('商城模块未加载');
            }
        });
    }

    const videoCallBtn = document.getElementById('video-call-btn');
    if (videoCallBtn) {
        videoCallBtn.addEventListener('click', () => {
            if (window.VideoCallModule) {
                window.VideoCallModule.showCallTypeModal();
                showPanel('none');
            } else {
                showToast('视频通话模块未加载');
            }
        });
    }

    const charGalleryManageBtn = document.getElementById('char-gallery-manage-btn');
    if (charGalleryManageBtn) {
        charGalleryManageBtn.addEventListener('click', () => {
            if (typeof openGalleryManager === 'function') {
                openGalleryManager();
                showPanel('none');
            } else {
                showToast('相册功能未加载');
            }
        });
    }

    document.getElementById('send-message-btn').addEventListener('click', sendMessage);
    document.getElementById('send-message-btn').addEventListener('touchend', (e) => {
        e.preventDefault();
        sendMessage();
        setTimeout(() => {
            messageInput.focus();
        }, 50);
    });
    messageInput.addEventListener('input', syncMessageInputHeight);
    messageInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        if (!isGenerating) sendMessage();
    });
    syncMessageInputHeight();

    // 监听输入框聚焦事件：自动收起底部面板，避免与键盘冲突
    messageInput.addEventListener('focus', () => {
        if (chatExpansionPanel.classList.contains('visible')) {
            // 立即禁用动画，防止键盘弹出时面板被顶起
            chatExpansionPanel.classList.add('no-transition');
            showPanel('none');
            // 恢复动画属性
            setTimeout(() => {
                chatExpansionPanel.classList.remove('no-transition');
            }, 100);
        }
    });

    getReplyBtn.addEventListener('click', () => getAiReply(currentChatId, currentChatType));
    regenerateBtn.addEventListener('click', handleRegenerate);
    
    messageArea.addEventListener('click', (e) => {
        if (isDebugMode) {
            const messageWrapper = e.target.closest('.message-wrapper');
            if (messageWrapper) {
                startDebugEdit(messageWrapper.dataset.id);
                return; 
            }
        }

        if (chatExpansionPanel.classList.contains('visible')) {
            showPanel('none');
            return;
        }

        if (e.target && e.target.id === 'load-more-btn') {
            loadMoreMessages();
        } else if (isInMultiSelectMode) {
            const messageWrapper = e.target.closest('.message-wrapper');
            if (messageWrapper) {
                toggleMessageSelection(messageWrapper.dataset.id);
            }
        } else {
            // 语音气泡：播放/停止按钮（任务三）
            const playBtn = e.target.closest('.voice-play-btn');
            if (playBtn) {
                const voiceBubble = playBtn.closest('.voice-bubble');
                const wrapper = voiceBubble ? voiceBubble.closest('.message-wrapper') : null;
                const toggleBtn = voiceBubble ? voiceBubble.querySelector('.voice-text-toggle') : null;
                const encodedText = toggleBtn ? toggleBtn.dataset.voiceText : null;
                const text = encodedText ? decodeURIComponent(encodedText) : '';
                // 仅角色侧语音气泡可走 TTS；用户自己发送的语音条（sent）禁止请求 MiniMax
                if (text && typeof TTSModule !== 'undefined') {
                    if (wrapper && wrapper.classList.contains('sent')) {
                        return;
                    }
                    const chat = currentChatType === 'private'
                        ? db.characters.find(c => c.id === currentChatId)
                        : null;
                    TTSModule.playVoiceBubble(text, chat, voiceBubble);
                }
                return;
            }

            // 语音气泡：文字展开/折叠按钮，与播放彻底解耦（任务三）
            const textToggle = e.target.closest('.voice-text-toggle');
            if (textToggle) {
                const voiceBubble = textToggle.closest('.voice-bubble');
                const transcript = voiceBubble
                    ? voiceBubble.closest('.message-wrapper').querySelector('.voice-transcript')
                    : null;
                if (transcript) {
                    transcript.classList.toggle('active');
                    textToggle.classList.toggle('expanded', transcript.classList.contains('active'));
                }
                return;
            }
            
            const bilingualBubble = e.target.closest('.bilingual-bubble');
            if (bilingualBubble) {
                const translationText = bilingualBubble.closest('.message-wrapper').querySelector('.translation-text');
                if (translationText) {
                    translationText.classList.toggle('active');
                }
            }

            const pvCard = e.target.closest('.pv-card');
            if (pvCard) {
                const imageOverlay = pvCard.querySelector('.pv-card-image-overlay');
                const footer = pvCard.querySelector('.pv-card-footer');
                imageOverlay.classList.toggle('hidden');
                footer.classList.toggle('hidden');
            }
            const giftCard = e.target.closest('.gift-card');
            if (giftCard) {
                const description = giftCard.closest('.message-wrapper').querySelector('.gift-card-description');
                if (description) {
                    description.classList.toggle('active');
                }
            }
            const transferCard = e.target.closest('.transfer-card.received-transfer');
            if (transferCard && currentChatType === 'private') {
                const messageWrapper = transferCard.closest('.message-wrapper');
                const messageId = messageWrapper.dataset.id;
                const character = db.characters.find(c => c.id === currentChatId);
                const message = character.history.find(m => m.id === messageId);
                if (message && message.transferStatus === 'pending') {
                    handleReceivedTransferClick(messageId);
                }
            }
        }
    });
    
    messageArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (e.target.id === 'load-more-btn' || isInMultiSelectMode) return;
        const messageWrapper = e.target.closest('.message-wrapper');
        if (!messageWrapper) return;
        handleMessageLongPress(messageWrapper, e.clientX, e.clientY);
    });
    messageArea.addEventListener('touchstart', (e) => {
        if (e.target.id === 'load-more-btn') return;
        const messageWrapper = e.target.closest('.message-wrapper');
        if (!messageWrapper) return;
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            handleMessageLongPress(messageWrapper, touch.clientX, touch.clientY);
        }, 400);
    });
    messageArea.addEventListener('touchend', () => clearTimeout(longPressTimer));
    messageArea.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    
    const messageEditForm = document.getElementById('message-edit-form');
    if(messageEditForm) {
        messageEditForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveMessageEdit();
        });
    }

    const cancelEditModalBtn = document.getElementById('cancel-edit-modal-btn');
    if(cancelEditModalBtn) {
        cancelEditModalBtn.addEventListener('click', cancelMessageEdit);
    }

    const hideTimestampBtn = document.getElementById('hide-timestamp-btn');
    if (hideTimestampBtn) {
        hideTimestampBtn.addEventListener('click', () => {
            if (!editingMessageId) return;
            
            const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
            const messageIndex = chat.history.findIndex(m => m.id === editingMessageId);
            
            let targetTime;
            if (messageIndex > 0) {
                const prevMsg = chat.history[messageIndex - 1];
                targetTime = prevMsg.timestamp + 60000; 
            } else {
                targetTime = Date.now(); 
            }
            
            const date = new Date(targetTime);
            const Y = date.getFullYear();
            const M = String(date.getMonth() + 1).padStart(2, '0');
            const D = String(date.getDate()).padStart(2, '0');
            const h = String(date.getHours()).padStart(2, '0');
            const m = String(date.getMinutes()).padStart(2, '0');
            
            const timestampInput = document.getElementById('message-edit-timestamp');
            if (timestampInput) {
                timestampInput.value = `${Y}-${M}-${D}T${h}:${m}`;
            }
        });
    }

    document.getElementById('cancel-multi-select-btn').addEventListener('click', exitMultiSelectMode);
    document.getElementById('delete-selected-btn').addEventListener('click', deleteSelectedMessages);
    document.getElementById('generate-capture-btn').addEventListener('click', generateCapture);
    document.getElementById('close-capture-modal-btn').addEventListener('click', () => {
        document.getElementById('capture-result-modal').classList.remove('visible');
    });
    document.getElementById('cancel-reply-btn').addEventListener('click', cancelQuoteReply);
}

/** 与 renderMessages 分页一致：返回包含 history[targetIndex] 的最小页码 */
function computePageForMessageIndex(totalMessages, pageSize, targetIndex) {
    if (totalMessages <= 0 || targetIndex < 0 || targetIndex >= totalMessages) return 1;
    const maxPage = Math.ceil(totalMessages / pageSize) || 1;
    for (let p = 1; p <= maxPage; p++) {
        const end = totalMessages - (p - 1) * pageSize;
        const start = Math.max(0, end - pageSize);
        if (targetIndex >= start && targetIndex < end) return p;
    }
    return maxPage;
}

/** 在消息区滚动到指定 data-id 的气泡并短暂高亮 */
function tryScrollToMessageById(messageId) {
    if (!messageId || typeof messageArea === 'undefined' || !messageArea) return false;
    let target = null;
    messageArea.querySelectorAll('.message-wrapper[data-id]').forEach((el) => {
        if (el.dataset.id === messageId) target = el;
    });
    if (!target) return false;
    target.classList.add('search-jump-highlight');
    window.setTimeout(() => target.classList.remove('search-jump-highlight'), 2600);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
}

/**
 * @param {string} chatId
 * @param {'private'|'group'} type
 * @param {object} [options]
 * @param {string} [options.scrollToMessageId] 打开后定位到该条消息（自动翻分页）
 */
function openChatRoom(chatId, type, options = {}) {
    const chat = (type === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return;

    currentChatId = chatId;
    currentChatType = type;

    let scrollToMessageId = options.scrollToMessageId || null;
    const pageSize = (typeof MESSAGES_PER_PAGE !== 'undefined') ? MESSAGES_PER_PAGE : 50;
    currentPage = 1;
    if (scrollToMessageId && chat.history && chat.history.length > 0) {
        const idx = chat.history.findIndex(m => m.id === scrollToMessageId);
        if (idx !== -1) {
            currentPage = computePageForMessageIndex(chat.history.length, pageSize, idx);
        } else {
            scrollToMessageId = null;
        }
    } else if (scrollToMessageId) {
        scrollToMessageId = null;
    }

    // 迁移旧的私聊数据 (仅群聊)
    if (type === 'group' && chat.privateSessions && typeof migratePrivateSessionsToHistory === 'function') {
        migratePrivateSessionsToHistory(chat);
        saveData(); // 迁移后立即保存
    }

    if (chat.unreadCount && chat.unreadCount > 0) {
        chat.unreadCount = 0;
        saveData();
        renderChatList(); 
    }
    exitMultiSelectMode();
    cancelMessageEdit();
    chatRoomTitle.textContent = (type === 'private') ? chat.remarkName : chat.name;
    const subtitle = document.getElementById('chat-room-subtitle');
    if (type === 'private') {
        subtitle.style.display = (chat.showStatus !== false) ? 'flex' : 'none';
        chatRoomStatusText.textContent = chat.status || '在线';
    } else {
        subtitle.style.display = 'none';
    }
    getReplyBtn.style.display = 'inline-flex';
    chatRoomScreen.style.backgroundImage = chat.chatBg ? `url(${chat.chatBg})` : 'none';
    typingIndicator.style.display = 'none';
    isGenerating = false;
    getReplyBtn.disabled = false;
    chatRoomScreen.className = chatRoomScreen.className.replace(/\bchat-active-[^ ]+\b/g, '');
    chatRoomScreen.classList.add(`chat-active-${chatId}`);
    
    const avatarRadius = chat.avatarRadius !== undefined ? chat.avatarRadius : 50;
    document.documentElement.style.setProperty('--chat-avatar-radius', `${avatarRadius}%`);

    if (chat.showTimestamp) {
        chatRoomScreen.classList.add('show-timestamp');
    } else {
        chatRoomScreen.classList.remove('show-timestamp');
    }
    chatRoomScreen.classList.remove('timestamp-side');

    chatRoomScreen.classList.remove('timestamp-style-bubble', 'timestamp-style-avatar');
    chatRoomScreen.classList.add(`timestamp-style-${chat.timestampStyle || 'bubble'}`);

    const header = document.getElementById('chat-room-header-default');
    if (chat.titleLayout === 'center') {
        header.classList.add('title-centered');
    } else {
        header.classList.remove('title-centered');
    }

    const journalBtnLabel = document.querySelector('#memory-journal-btn .expansion-item-name');
    if (journalBtnLabel) {
        journalBtnLabel.textContent = (type === 'group') ? '总结' : '日记';
    }

    const starBtn = document.getElementById('char-status-btn');
    if (starBtn) {
        if (type === 'private' && chat.statusPanel && chat.statusPanel.enabled) {
            starBtn.style.display = 'flex';
        } else {
            starBtn.style.display = 'none';
        }
    }

    const roomSearchBtn = document.getElementById('chat-room-search-btn');
    if (roomSearchBtn) {
        roomSearchBtn.style.display = 'flex';
    }

    const peekBtn = document.getElementById('peek-btn');
    if (peekBtn) {
        if (type === 'group' && chat.allowGossip) {
            peekBtn.style.display = 'flex';
            const hasUnread = Object.values(gossipUnreadMap || {}).some(count => count > 0);
            const badge = document.getElementById('gossip-badge');
            if (hasUnread) {
                peekBtn.classList.add('has-unread');
                if (badge) badge.style.display = 'block';
            } else {
                peekBtn.classList.remove('has-unread');
                if (badge) badge.style.display = 'none';
            }
        } else {
            peekBtn.style.display = 'none';
            peekBtn.classList.remove('has-unread');
            const badgeHidden = document.getElementById('gossip-badge');
            if (badgeHidden) badgeHidden.style.display = 'none';
        }
    }

    const peekPrivateExpansion = document.getElementById('peek-private-expansion-btn');
    if (peekPrivateExpansion) {
        peekPrivateExpansion.style.display = type === 'private' ? '' : 'none';
    }

    updateCustomBubbleStyle(chatId, chat.customBubbleCss, chat.useCustomBubbleCss);
    const forceScrollToBottom = !scrollToMessageId;
    renderMessages(false, forceScrollToBottom);
    switchScreen('chat-room-screen');

    if (window.GuideSystem) {
        window.GuideSystem.check('guide_search_entry');
    }

    if (scrollToMessageId) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!tryScrollToMessageById(scrollToMessageId) && typeof showToast === 'function') {
                    showToast('未找到该条消息，可能已被删除或不在当前显示范围');
                }
            });
        });
    }
    
    requestAnimationFrame(() => {
        void document.body.offsetHeight; 
    });
}

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isGenerating) return;
    messageInput.value = '';
    syncMessageInputHeight();
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);

    if (!chat) return;
    if (!chat.history) chat.history = [];

    let messageContent;
    const systemRegex = /\[system:.*?\]|\[system-display:.*?\]/;
    const inviteRegex = /\[.*?邀请.*?加入群聊\]/;
    const renameRegex = /\[(.*?)修改群名为“(.*?)”\]/;
    const shopOrderRegex = /\[.*?为你下单的商品：.*?\]/;
    const myName = (currentChatType === 'private') ? chat.myName : chat.me.nickname;

    if (renameRegex.test(text)) {
        const match = text.match(renameRegex);
        chat.name = match[2];
        chatRoomTitle.textContent = chat.name;
        messageContent = `[${chat.me.nickname}修改群名为“${chat.name}”]`;
    } else if (systemRegex.test(text) || inviteRegex.test(text) || shopOrderRegex.test(text)) {
        messageContent = text;
    } else {
        let userText = text;
        messageContent = `[${myName}的消息：${userText}]`;
    }

    const message = {
        id: `msg_${Date.now()}`,
        role: 'user',
        content: messageContent,
        parts: [{type: 'text', text: messageContent}],
        timestamp: Date.now()
    };

    if (currentQuoteInfo) {
        message.quote = {
            messageId: currentQuoteInfo.id,
            senderId: currentQuoteInfo.senderId, 
            content: currentQuoteInfo.content
        };
    }

    if (currentChatType === 'group') {
        message.senderId = 'user_me';
    }
    chat.history.push(message);
    addMessageBubble(message, currentChatId, currentChatType);
    triggerHapticFeedback('success');

    if (chat.history.length > 0 && chat.history.length % 300 === 0) {
        promptForBackupIfNeeded('history_milestone');
    }

    await saveData();
    renderChatList();

    if (currentQuoteInfo) {
        cancelQuoteReply();
    }
}

// 备份提示
function promptForBackupIfNeeded(triggerType) {
    if (triggerType === 'history_milestone') {
        showToast('uwu提醒您：记得备份噢');
    }
}
