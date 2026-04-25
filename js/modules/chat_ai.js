// --- AI 交互模块 ---


/** 时间感知：与上一条消息间隔超过此值时触发（与设置说明一致） */
const TIME_PERCEPTION_GAP_MS = 7 * 60 * 1000;

/**
 * 从当前 chat.history 裁剪并过滤，得到与发 API 一致的历史切片（可多次调用，如插入时间感知条后需重算）。
 */
function buildFilteredHistorySliceForAi(chat) {
    let historySlice = chat.history.slice(-chat.maxMemory);
    historySlice = filterHistoryForAI(chat, historySlice);
    historySlice = historySlice.filter(m => !m.isContextDisabled);
    historySlice = historySlice.filter(m => {
        if (m.isThinking) return false;
        if (m.content && typeof m.content === 'string' && m.content.trim().startsWith('<thinking>')) return false;
        return true;
    });
    return historySlice;
}

/**
 * 自 historySlice[beforeIdx] 向前找「对方」锚点：私聊为最后一条非时间感知条目的 assistant；群聊为 assistant 或「非 user_me 的 user」。
 * 用于计算「他最后一条 ↔ 我本轮首条」的沉默间隔（跳过本功能已插入的 timePerception 双条）。
 */
function findTimePerceptionBAnchorMessage(historySlice, beforeIdx, chatType) {
    for (let j = beforeIdx - 1; j >= 0; j--) {
        const m = historySlice[j];
        if (m.isTimePerceptionContext || m.isTimePerceptionDisplay) continue;
        if (chatType === 'private' && m.role === 'assistant') return m;
        if (chatType === 'group') {
            if (m.role === 'assistant') return m;
            if (m.role === 'user' && m.senderId && m.senderId !== 'user_me') return m;
        }
    }
    return null;
}

/**
 * 两消息间隔 B 的长说明：只拼进**当次** API，不入库（库内只保留 `buildTimePerceptionBShortForHistory` 一条）。
 */
function buildTimePerceptionBLongInstructionForRequest(timeGapStr) {
    return `[系统通知：距离上一次对话已经过去了${timeGapStr}。请严格结合你的【角色性格】、【与当前用户的关系亲密度】、以及【当前的聊天上下文内容与氛围】（例如：你们是在日常闲聊、争吵冷战、还是暧昧拉扯等情况），综合判断是否需要对这段时间的流逝作出反应。绝不能每次都机械地询问对方去向，必须保持真人沟通的逻辑连贯性与自然边界感。]\n\n`;
}

function buildTimePerceptionBShortForHistory(timeGapStr) {
    return `距离上一次对话已过去${timeGapStr}。`;
}

/**
 * 时间感知（B）：对方最后一条 → 本轮首条用户话的间隔超阈值时，在本轮首条前入库双条（入库仅短事实；长说明见上函数，由 getAiReply 拼到本次请求）。
 * 成功后在首条 user 上打 timePerceptionBGapInjected，API 失败重试要回复时不再叠插。与「迟点请求回复」互斥。非后台。
 * @returns {string|null} 成功时返回 timeGapStr，供本轮 prepend 长说明；未插入时 null
 */
function tryInsertTimePerceptionHistoryB(chat, chatType, isBackground, historySlice, needsReplyLatencyTimePerceptionPrivate) {
    if (isBackground || !chat.timePerceptionEnabled) return null;
    if (needsReplyLatencyTimePerceptionPrivate) return null;
    const histLen = historySlice.length;
    if (histLen < 2) return null;
    if (historySlice[histLen - 1].role !== 'user' || !isUserMessageFromMeInContext(historySlice[histLen - 1], chatType)) {
        return null;
    }
    // 自末尾起连续「我方」的 user 向上扩，取本轮首条
    let runStart = histLen - 1;
    while (runStart > 0) {
        const p = historySlice[runStart - 1];
        if (p.role === 'user' && isUserMessageFromMeInContext(p, chatType)) runStart--;
        else break;
    }
    const firstUser = historySlice[runStart];
    if (runStart < 1) return null;
    if (firstUser && typeof firstUser.timestamp !== 'number') return null;
    const anchor = findTimePerceptionBAnchorMessage(historySlice, runStart, chatType);
    if (!anchor || typeof anchor.timestamp !== 'number') return null;
    const timeDiff = firstUser.timestamp - anchor.timestamp;
    if (timeDiff <= TIME_PERCEPTION_GAP_MS) return null;
    // 同轮首条用户话已打过标 / 或紧挨前已有 B 双条时不再插（避免 API 失败后重点要回复叠两套）
    const realUserRef = chat.history.find(m => m.id === firstUser.id);
    if (realUserRef && realUserRef.timePerceptionBGapInjected) return null;
    const headPos = chat.history.findIndex(m => m.id === firstUser.id);
    if (headPos < 0) return null;
    for (let hi = headPos - 1; hi >= 0 && hi >= headPos - 2; hi--) {
        const m = chat.history[hi];
        if (m.isTimePerceptionContext || m.isTimePerceptionDisplay) return null;
    }

    const timeGapStr = formatTimeGap(timeDiff);
    const tpId = `tp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const shortForHistory = buildTimePerceptionBShortForHistory(timeGapStr);
    const visualMessage = {
        id: `${tpId}_vis`,
        role: 'system',
        content: `[system-display:已过去${timeGapStr}]`,
        parts: [],
        timestamp: firstUser.timestamp,
        isTimePerceptionDisplay: true,
        timePerceptionPairId: tpId
    };
    const contextMessage = {
        id: `${tpId}_ctx`,
        role: 'user',
        content: `[system: ${shortForHistory}]`,
        parts: [{ type: 'text', text: `[system: ${shortForHistory}]` }],
        timestamp: firstUser.timestamp,
        isTimePerceptionContext: true,
        timePerceptionPairId: tpId
    };
    if (chatType === 'group') {
        visualMessage.senderId = 'user_me';
        contextMessage.senderId = 'user_me';
    }
    const insertAt = chat.history.findIndex(m => m.id === firstUser.id);
    if (insertAt === -1) {
        chat.history.splice(Math.max(0, chat.history.length - 1), 0, visualMessage, contextMessage);
    } else {
        chat.history.splice(insertAt, 0, visualMessage, contextMessage);
    }
    const userAfterSplice = chat.history.find(m => m.id === firstUser.id);
    if (userAfterSplice) userAfterSplice.timePerceptionBGapInjected = true;
    return timeGapStr;
}

/**
 * 私聊：除 assistant 外皆视为「我」；群聊：senderId 为 user_me 或缺失的 user 视为我方。
 */
function isUserMessageFromMeInContext(msg, chatType) {
    if (msg.role !== 'user') return false;
    if (chatType === 'private') return true;
    return !msg.senderId || msg.senderId === 'user_me';
}

/**
 * 私聊「未发消息继续要回复」时仅注入本次 API 请求（单条 user），不入库。
 * 静默超过阈值时在末尾追加一段 [频道系统] 时间说明；与原有「两条消息间隔」时间感知互斥（由调用处跳过旧逻辑）。
 */
function buildChannelContinueUserPrompt(historySlice) {
    const lastMsg = historySlice[historySlice.length - 1];
    const lastTs = (lastMsg && typeof lastMsg.timestamp === 'number') ? lastMsg.timestamp : Date.now();
    const silenceMs = Date.now() - lastTs;

    let text = `[频道系统] 对方暂未输入。请严格依据上文语境、情绪与关系亲密度，并结合你作为角色自身的人设、性格特点、世界观与背景等，像活人一样自行判断是否续写、如何续写；以你的角色身份自然续写一条或多条回复，不要复述本句，不要把它当作对方说的话。`;

    if (silenceMs > TIME_PERCEPTION_GAP_MS) {
        const gapStr = formatTimeGap(silenceMs);
        text += `\n\n[频道系统] 自本会话最后一条消息起至本次延续请求，已过去约${gapStr}。对方未发送新消息；此为界面触发的续写请求。请结合上文语境、情绪与关系亲密度以及你的人设、性格、世界观与背景，自行判断是否在语气或内容里体现这段空白，避免每次机械抱怨久等或追问去向；若剧情上适合沉默衔接，也可自然接话而不强调时间。`;
    }

    return text;
}

/**
 * 私聊：最后一条为用户、点「要回复」时墙钟距该条超过阈值 → 仅 prepend 到本次 API 最后一条 user（不入库）。
 * 与两消息间隔 B 互斥：同时满足时 tryInsert 不执行，只走本段（说明迟点按「要回复」的一方）。
 */
function buildPrivateReplyLatencyTimeNotice(latencyMs) {
    const timeGapStr = formatTimeGap(latencyMs);
    return `[系统通知：对方（用户）的最后一条消息已发出约${timeGapStr}；在此期间对方并未离开对话，消息一直停留在聊天中，而是你（角色）直至此次「请求回复」被触发才作出回复——空白来自你方迟复，而非对方消失。若要在语气或内容中体现这段时间，请优先从自身角度合理发挥（如在忙、刚看到、忘记回、不便打字等），也可自然接话而不强调时间；严禁写成对方失联、对方玩消失、苦等对方出现等颠倒因果的表述。请结合【角色设定】【关系亲密度】与【当前上下文】自行把握分寸，避免每次机械道歉或重复套路。若上下文已随时间推进（例如对方曾提及稍后要做的活动），允许像真人一样假设该活动已结束或情境已变化后再接话。]\n\n`;
}

/**
 * 是否应播放网页内「收到回复」提示音：仅前台且停留在该会话聊天室。
 * 后台 / 其它会话由系统 Notification 发声，此处必须返回 false，禁止与系统提示音叠播。
 */
function shouldPlayInternalReceiveSound(chatId) {
    if (typeof PushNotificationModule !== 'undefined' &&
        typeof PushNotificationModule.isForegroundActiveThisChat === 'function') {
        return PushNotificationModule.isForegroundActiveThisChat(chatId);
    }
    if (document.hidden) return false;
    const chatRoomScreen = document.getElementById('chat-room-screen');
    return !!(chatRoomScreen &&
        chatRoomScreen.classList.contains('active') &&
        chatRoomScreen.classList.contains(`chat-active-${chatId}`));
}

// AI 交互逻辑
async function getAiReply(chatId, chatType, isBackground = false) {
    if (isGenerating && !isBackground) return; 
    
    if (!isBackground) {
        if (db.globalSendSound) {
            playSound(db.globalSendSound);
        } else {
            AudioManager.unlock();
        }
    }

    let {url, key, model, provider, streamEnabled} = db.apiSettings; 
    if (!url || !key || !model) {
        if (!isBackground) {
            showToast('请先在“api”应用中完成设置！');
            switchScreen('api-settings-screen');
        }
        return;
    }

    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    const chat = (chatType === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return;

    // 通话进行中：禁止文字区后台自动回复，避免与通话模块并发、同角色在聊天室误发消息
    if (isBackground) {
        if (typeof VideoCallModule !== 'undefined' && VideoCallModule.state && VideoCallModule.state.isCallActive) {
            if (chat.autoReply) chat.autoReply.lastTriggerTime = Date.now();
            return;
        }
    }

    if (!isBackground) {
        isGenerating = true;
        getReplyBtn.disabled = true;
        regenerateBtn.disabled = true;
        const typingName = chatType === 'private' ? chat.remarkName : chat.name;
        typingIndicator.textContent = `“${typingName}”正在输入中...`;
        typingIndicator.style.display = 'block';
        messageArea.scrollTop = messageArea.scrollHeight;
    }

    try {
        let systemPrompt, requestBody;
        if (chatType === 'private') {
            systemPrompt = generatePrivateSystemPrompt(chat);
        } else {
            // generateGroupSystemPrompt 应该在 group_chat.js 中定义
            if (typeof generateGroupSystemPrompt === 'function') {
                systemPrompt = generateGroupSystemPrompt(chat);
            } else {
                systemPrompt = "Group chat system prompt not available.";
            }
        }

        // 添加聊天记录提示
        systemPrompt += "\n\n以下为当前聊天记录：\n";
        
        let historySlice = buildFilteredHistorySliceForAi(chat);

        /* 时间感知相关（均受总开关等条件约束，此处只列分工）：
         * 1) 两消息间隔·B：对方最后一条 → 本轮首条用户话，>7 分钟则插灰条 + 入库短 [system: 已过去X]；长「系统通知+性格亲密度等」只拼在**当次**请求、不入库。与(2)互斥。
         * 2) 迟点要回复：私聊、点要回复时墙钟距该条>7 分钟，仅当次 API 拼文；与(1)互斥（优先后者）。
         * 3) 无新消息继续：末条 assistant + 开续写 → 频道续写。末条非 user 则不走(1)。
         * 4) 后台 isBackground 另一套；前台 B 在 isBackground 不执行。
         */
        const needsChannelContinuePrivate =
            !isBackground &&
            chatType === 'private' &&
            chat.continueReplyWithoutUserEnabled &&
            historySlice.length > 0 &&
            historySlice[historySlice.length - 1].role === 'assistant';

        const lastHistMsgForLatency = historySlice.length > 0 ? historySlice[historySlice.length - 1] : null;
        const needsReplyLatencyTimePerceptionPrivate =
            !isBackground &&
            chatType === 'private' &&
            chat.timePerceptionEnabled &&
            lastHistMsgForLatency &&
            lastHistMsgForLatency.role === 'user' &&
            typeof lastHistMsgForLatency.timestamp === 'number' &&
            (Date.now() - lastHistMsgForLatency.timestamp) > TIME_PERCEPTION_GAP_MS;

        const timePerceptionBGapForThisRequest = tryInsertTimePerceptionHistoryB(chat, chatType, isBackground, historySlice, needsReplyLatencyTimePerceptionPrivate);
        if (timePerceptionBGapForThisRequest != null) {
            historySlice = buildFilteredHistorySliceForAi(chat);
            try {
                if (typeof saveData === 'function') await saveData();
            } catch (e) {
                console.error('saveData after 时间感知入库', e);
            }
            if (typeof currentChatId !== 'undefined' && currentChatId === chatId &&
                typeof currentChatType !== 'undefined' && currentChatType === chatType &&
                typeof renderMessages === 'function') {
                renderMessages(false, true);
            }
        }

        if (provider === 'gemini') {
            const contents = historySlice.map(msg => {
                const role = msg.role === 'assistant' ? 'model' : 'user';

                let parts;
                if (msg.parts && msg.parts.length > 0) {
                    parts = msg.parts.map(p => {
                        if (p.type === 'text' || p.type === 'html') {
                            return {text: p.text};
                        } else if (p.type === 'image') {
                            const match = p.data.match(/^data:(image\/(.+));base64,(.*)$/);
                            if (match) {
                                return {inline_data: {mime_type: match[1], data: match[3]}};
                            }
                        }
                        return null;
                    }).filter(p => p);
                } else {
                    parts = [{text: msg.content}];
                }

                return {role, parts};
            });

            // 后台自动回复：注入精确时间差（仅由"后台自动发送消息"开关控制）
            if (isBackground) {
                const lastMsgTimestamp = historySlice.length > 0 ? historySlice[historySlice.length - 1].timestamp : 0;
                const bgTimeDiff = lastMsgTimestamp
                    ? Date.now() - lastMsgTimestamp
                    : (chat.autoReply && chat.autoReply.interval ? chat.autoReply.interval * 60 * 1000 : 60 * 60 * 1000);
                const bgTimeGapStr = formatTimeGap(bgTimeDiff);
                contents.push({
                    role: 'user',
                    parts: [{ text: `[系统通知：距离上次互动已经过去了${bgTimeGapStr}。请严格结合你的【角色设定】、【与当前用户的关系亲密度】与【当前的聊天上下文内容和氛围】，综合判断是否需要对这段时间的流逝作出反应以及是否自然地延续对话（例如：若是闲聊，可自然延续话题或者发起新话题，若是之前在争吵，请延续情绪或主动破冰），绝对不要每次都机械地抱怨或提及对方消失了多久，保持活人的真实沟通节奏。]` }]
                });
            }

            if (!isBackground && timePerceptionBGapForThisRequest && contents.length > 0) {
                const timeNoticeB = buildTimePerceptionBLongInstructionForRequest(timePerceptionBGapForThisRequest);
                const lastContentB = contents[contents.length - 1];
                if (lastContentB && lastContentB.role === 'user' && lastContentB.parts && lastContentB.parts.length > 0) {
                    if (lastContentB.parts[0].text) {
                        lastContentB.parts[0].text = timeNoticeB + lastContentB.parts[0].text;
                    } else {
                        lastContentB.parts.unshift({ text: timeNoticeB.trimEnd() });
                    }
                }
            }

            if (needsReplyLatencyTimePerceptionPrivate && contents.length > 0) {
                const latencyMs = Date.now() - historySlice[historySlice.length - 1].timestamp;
                const timeNoticeGemini = buildPrivateReplyLatencyTimeNotice(latencyMs);
                const lastContent = contents[contents.length - 1];
                if (lastContent && lastContent.role === 'user' && lastContent.parts && lastContent.parts.length > 0) {
                    if (lastContent.parts[0].text) {
                        lastContent.parts[0].text = timeNoticeGemini + lastContent.parts[0].text;
                    } else {
                        lastContent.parts.unshift({ text: timeNoticeGemini.trimEnd() });
                    }
                }
            }

            if (needsChannelContinuePrivate) {
                contents.push({
                    role: 'user',
                    parts: [{ text: buildChannelContinueUserPrompt(historySlice) }]
                });
            }

            requestBody = {
                contents: contents,
                system_instruction: {parts: [{text: systemPrompt}]},
                generationConfig: {
                    temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 1.0
                }
            };
        } else {
            const messages = [{role: 'system', content: systemPrompt}];
            
            historySlice.forEach(msg => {
               let content;

               if (msg.role === 'user' && msg.quote) {
                   const replyTextMatch = msg.content.match(/\[.*?的消息：([\s\S]+?)\]/);
                   const replyText = replyTextMatch ? replyTextMatch[1] : msg.content;
                   content = `[${chat.myName}引用"${msg.quote.content}"并回复：${replyText}]`;
                   messages.push({ role: 'user', content: content });

               } else {
                   if (msg.parts && msg.parts.length > 0) {
                       content = msg.parts.map(p => {
                           if (p.type === 'text' || p.type === 'html') {
                               return {type: 'text', text: p.text};
                           } else if (p.type === 'image') {
                               return {type: 'image_url', image_url: {url: p.data}};
                           }
                           return null;
                       }).filter(p => p);
                   } else {
                       content = msg.content;
                   }

                   // OpenAI 兼容协议不支持 system 角色出现在对话中间，会被 API 忽略
                   // 将历史中的 system 消息（如通话记录总结）转为 user 角色，确保 AI 能读取到
                   const apiRole = msg.role === 'system' ? 'user' : msg.role;
                   if (typeof content === 'string') {
                       messages.push({role: apiRole, content: content});
                   } else {
                       messages.push({role: apiRole, content: content});
                   }
               }
            });

            // === 后台通知与 CoT 序列 ===

            // 1. 后台自动回复：注入精确时间差（仅由"后台自动发送消息"开关控制）
            if (isBackground) {
                const lastMsgTimestamp = historySlice.length > 0 ? historySlice[historySlice.length - 1].timestamp : 0;
                const bgTimeDiff = lastMsgTimestamp
                    ? Date.now() - lastMsgTimestamp
                    : (chat.autoReply && chat.autoReply.interval ? chat.autoReply.interval * 60 * 1000 : 60 * 60 * 1000);
                const bgTimeGapStr = formatTimeGap(bgTimeDiff);
                messages.push({
                    role: 'user',
                    content: `[系统通知：距离上次互动已经过去了${bgTimeGapStr}。请严格结合你的【角色设定】、【与当前用户的关系亲密度】与【当前的聊天上下文内容和氛围】，综合判断是否需要对这段时间的流逝作出反应以及是否自然地延续对话（例如：若是闲聊，可自然延续话题或者发起新话题，若是之前在争吵，请延续情绪或主动破冰），绝对不要每次都机械地抱怨或提及对方消失了多久，保持活人的真实沟通节奏。]`
                });
            }

            if (!isBackground && timePerceptionBGapForThisRequest && messages.length > 0) {
                const timeNoticeB = buildTimePerceptionBLongInstructionForRequest(timePerceptionBGapForThisRequest);
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].role === 'user') {
                        if (typeof messages[i].content === 'string') {
                            messages[i].content = timeNoticeB + messages[i].content;
                        } else if (Array.isArray(messages[i].content)) {
                            const firstText = messages[i].content.find(p => p.type === 'text');
                            if (firstText) firstText.text = timeNoticeB + firstText.text;
                            else messages[i].content.unshift({ type: 'text', text: timeNoticeB.trimEnd() });
                        }
                        break;
                    }
                }
            }

            if (needsReplyLatencyTimePerceptionPrivate && messages.length > 0) {
                const latencyMs = Date.now() - historySlice[historySlice.length - 1].timestamp;
                const timeNotice = buildPrivateReplyLatencyTimeNotice(latencyMs);
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].role === 'user') {
                        if (typeof messages[i].content === 'string') {
                            messages[i].content = timeNotice + messages[i].content;
                        } else if (Array.isArray(messages[i].content)) {
                            const firstText = messages[i].content.find(p => p.type === 'text');
                            if (firstText) firstText.text = timeNotice + firstText.text;
                            else messages[i].content.unshift({ type: 'text', text: timeNotice.trimEnd() });
                        }
                        break;
                    }
                }
            }

            if (needsChannelContinuePrivate) {
                messages.push({
                    role: 'user',
                    content: buildChannelContinueUserPrompt(historySlice)
                });
            }

            // 3. 插入 CoT 序列（无论前台后台，只要开启就插入）
            const cotEnabled = db.cotSettings && db.cotSettings.enabled;
            
            if (cotEnabled) {
                let cotInstruction = '';
                const activePresetId = (db.cotSettings && db.cotSettings.activePresetId) || 'default';
                const preset = (db.cotPresets || []).find(p => p.id === activePresetId);
                
                if (preset && preset.items) {
                    cotInstruction = preset.items
                        .filter(item => item.enabled)
                        .map(item => item.content)
                        .join('\n\n');
                }

                if (cotInstruction) {
                    // 1. 插入后置指令
                    messages.push({
                        role: 'system', // 或者 'user'
                        content: cotInstruction
                    });

                    // 2. 插入触发器
                    messages.push({
                        role: 'user',
                        content: '[incipere]'
                    });

                    // 3. 插入 Prefill (预填/强塞)
                    messages.push({
                        role: 'assistant',
                        content: '<thinking>'
                    });
                }
            }

            requestBody = {
                model: model, 
                messages: messages, 
                stream: streamEnabled,
                temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 1.0
            };
        }
        console.log('[DEBUG] AutoReply Request Body:', JSON.stringify(requestBody));
        const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:streamGenerateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
        const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        };
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const error = new Error(`API Error: ${response.status} ${await response.text()}`);
            error.response = response;
            throw error;
        }
        
        if (streamEnabled) {
            await processStream(response, chat, provider, chatId, chatType, isBackground);
        } else {
            let result;
            try {
                result = await response.json();
                console.log('【API完整响应数据】:', result);
            } catch (e) {
                const text = await response.text();
                console.error("Failed to parse JSON:", text);
                throw new Error(`API返回了非JSON格式数据 (可能是网页HTML)。请检查API地址是否正确。原始内容开头: ${text.substring(0, 50)}...`);
            }

            let fullResponse = "";
            if (provider === 'gemini') {
                fullResponse = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
            } else {
                fullResponse = result.choices[0].message.content;
            }
            
            // === 【补丁：把被吃掉的开头补回来】 ===
            // 仅在 CoT 开启且检测到闭合标签时补全
            const cotEnabled = db.cotSettings && db.cotSettings.enabled;
            // 【修改】去掉了 !isBackground，确保后台模式也能正确补全标签
            if (cotEnabled && fullResponse && !fullResponse.trim().startsWith('<thinking>')) {
                 if (fullResponse.includes('</thinking>')) {
                     fullResponse = '<thinking>' + fullResponse;
                 }
            }
            // ===================================
            
            
            await handleAiReplyContent(fullResponse, chat, chatId, chatType, isBackground);
        }

    } catch (error) {
        if (!isBackground) showApiError(error);
        else console.error("Background Auto-Reply Error:", error);
    } finally {
        if (!isBackground) {
            isGenerating = false;
            getReplyBtn.disabled = false;
            regenerateBtn.disabled = false;
            typingIndicator.style.display = 'none';
        }
    }
}

async function processStream(response, chat, apiType, targetChatId, targetChatType, isBackground = false) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let fullResponse = "", accumulatedChunk = "";
    for (; ;) {
        const {done, value} = await reader.read();
        if (done) break;
        accumulatedChunk += decoder.decode(value, {stream: true});
        if (apiType === "openai" || apiType === "deepseek" || apiType === "claude" || apiType === "newapi") {
            const parts = accumulatedChunk.split("\n\n");
            accumulatedChunk = parts.pop();
            for (const part of parts) {
                if (part.startsWith("data: ")) {
                    const data = part.substring(6);
                    if (data.trim() !== "[DONE]") {
                        try {
                            fullResponse += JSON.parse(data).choices[0].delta?.content || "";
                        } catch (e) { 
                        }
                    }
                }
            }
        }
    }
    if (apiType === "gemini") {
        try {
            const parsedStream = JSON.parse(accumulatedChunk);
            fullResponse = parsedStream.map(item => item.candidates?.[0]?.content?.parts?.[0]?.text || "").join('');
        } catch (e) {
            console.error("Error parsing Gemini stream:", e, "Chunk:", accumulatedChunk);
            if (!isBackground) showToast("解析Gemini响应失败");
            return;
        }
    }
    // === 【补丁：补全流式输出时丢失的开头标签】 ===
        // === 【补丁：补全流式输出时丢失的开头标签】 ===
    // 无论前台后台，只要是CoT开启且被预填吃掉了开头，都要补回来
    const cotEnabled = db.cotSettings && db.cotSettings.enabled;
    // 【修改】去掉了 !isBackground，确保后台模式也能正确补全标签
    if (cotEnabled && fullResponse && !fullResponse.trim().startsWith('<thinking>')) {
         // 这里判断：如果内容里有闭合的 </thinking> 但开头没有 <thinking>，说明开头被 Prefill 吃掉了
         if (fullResponse.includes('</thinking>')) {
             fullResponse = '<thinking>' + fullResponse;
         }
    }

    // ===================
    await handleAiReplyContent(fullResponse, chat, targetChatId, targetChatType, isBackground);
}

/**
 * 角色「引用并回复」与用户历史对齐：优先整段与某条用户文字消息相等；
 * 否则允许引号内为用户该条消息中的连续子串（与提示里「针对某句话」一致，子串过短易误匹配故设下限）。
 */
function findUserMessageForCharacterQuote(chat, quotedText) {
    const q = (quotedText || '').trim();
    if (!q) return null;
    const reversed = chat.history.slice().reverse();
    const extractUserPlain = (m) => {
        if (m.role !== 'user') return '';
        const userMessageMatch = m.content.match(/\[.*?的消息：([\s\S]+?)\]/);
        return userMessageMatch ? userMessageMatch[1].trim() : m.content.trim();
    };
    for (let i = 0; i < reversed.length; i++) {
        const m = reversed[i];
        if (m.role !== 'user') continue;
        const plain = extractUserPlain(m);
        if (plain && plain === q) return m;
    }
    const MIN_SUBSTRING_LEN = 5;
    if (q.length < MIN_SUBSTRING_LEN) return null;
    for (let i = 0; i < reversed.length; i++) {
        const m = reversed[i];
        if (m.role !== 'user') continue;
        const plain = extractUserPlain(m);
        if (plain && plain.includes(q)) return m;
    }
    return null;
}

async function handleAiReplyContent(fullResponse, chat, targetChatId, targetChatType, isBackground = false) {
    const rawResponse = fullResponse;
    /** 本轮解析出的内在状态，挂到本回合每条私聊 assistant 气泡上，删消息时可回退 */
    let innerStateSnapshotForRound = null;
    if (fullResponse) {
        // 1. 移除 [incipere] 标签
        fullResponse = fullResponse.replace(/\[incipere\]/g, "");

        // 2. 捕获并静默处理 [内在状态：xxx]（不产生任何气泡）
        const innerStateMatch = fullResponse.match(/\[内在状态[：:]([\s\S]*?)\]/);
        if (innerStateMatch) {
            const innerStateContent = innerStateMatch[1].trim();
            if (targetChatType === 'private') {
                chat.innerState = innerStateContent;
                innerStateSnapshotForRound = innerStateContent;
                // 通知便利贴面板刷新
                if (typeof refreshInnerStatePanel === 'function') {
                    refreshInnerStatePanel(chat.id, innerStateContent);
                }
            }
            // 从回复文本中移除，不产生任何气泡
            fullResponse = fullResponse.replace(innerStateMatch[0], "").trim();
        }

        // 3. 捕获并分离 <thinking> 内容
        const thinkingMatch = fullResponse.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch) {
            const thinkingContent = thinkingMatch[0]; // 包含标签的完整内容
            
            // 创建思考过程消息对象
            const thinkingMsg = {
                id: `msg_${Date.now()}_${Math.random()}`,
                role: 'assistant',
                content: thinkingContent,
                timestamp: Date.now(),
                isThinking: true,
                isContextDisabled: true // 【关键】标记为不进入上下文
            };
            
            // 存入历史记录
            chat.history.push(thinkingMsg);

            // 【新增】清理旧的思维链消息，仅保留最近 50 条
            const maxThinkingMsgs = 50;
            let thinkingCount = 0;
            const idsToRemove = new Set();
            // 从后往前遍历，保留最近的 50 个，其他的标记为待删除
            for (let i = chat.history.length - 1; i >= 0; i--) {
                if (chat.history[i].isThinking) {
                    thinkingCount++;
                    if (thinkingCount > maxThinkingMsgs) {
                        idsToRemove.add(chat.history[i].id);
                    }
                }
            }
            if (idsToRemove.size > 0) {
                chat.history = chat.history.filter(m => !idsToRemove.has(m.id));
            }
            
            // 添加到界面气泡（由于 regex 设置，会被隐藏，仅 Debug 模式可见）
            addMessageBubble(thinkingMsg, targetChatId, targetChatType);
            
            // 从即将显示的文本中移除思考内容
            fullResponse = fullResponse.replace(thinkingContent, "");
        }

        if (db.globalReceiveSound && shouldPlayInternalReceiveSound(targetChatId)) {
            playSound(db.globalReceiveSound);
        }
        if (typeof PushNotificationModule !== 'undefined') {
            const _pnName = targetChatType === 'private'
                ? (chat.remarkName || chat.realName || chat.name || '')
                : (chat.name || '');
            PushNotificationModule.notify(targetChatId, targetChatType, _pnName, fullResponse);
        }
        // ... 后续代码保持不变 ...
        console.log('【AI原始返回内容】:', rawResponse);
        let cleanedResponse = fullResponse.replace(/^\[system:.*?\]\s*/, '').replace(/^\(时间:.*?\)\s*/, '');
        const trimmedResponse = cleanedResponse.trim();
        let messages;

        if (trimmedResponse.startsWith('<') && trimmedResponse.endsWith('>')) {
            messages = [{ type: 'html', content: trimmedResponse }];
        } else {
            messages = getMixedContent(fullResponse).filter(item => item.content.trim() !== '');
        }

        let firstMessageProcessed = false;
        /** 本轮 AI 写入 history 的起始下标（用于末尾统一挂上内在状态快照，避免分支漏挂） */
        const assistantRoundHistoryStart = chat.history.length;

        for (const item of messages) {
            // --- 视频/语音通话邀请检测 ---
            const callInviteRegex = /\[(.*?)向(.*?)发起了(视频|语音)通话\]/;
            const callInviteMatch = item.content.match(callInviteRegex);
            if (callInviteMatch) {
                const type = callInviteMatch[3] === '视频' ? 'video' : 'voice';
                // 触发来电界面
                if (window.VideoCallModule && typeof window.VideoCallModule.receiveCall === 'function') {
                    window.VideoCallModule.receiveCall(type);
                }
                // 不将此消息显示为普通气泡，或者显示为系统通知
                // 这里选择显示为系统通知样式的消息
                const message = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'system', // 使用 system 角色
                    content: item.content.trim(),
                    timestamp: Date.now()
                };
                chat.history.push(message);
                addMessageBubble(message, targetChatId, targetChatType);
                continue; // 跳过后续处理
            }

            if (targetChatType === 'private') {
                const char = db.characters.find(c => c.id === targetChatId);
                if (char && char.statusPanel && char.statusPanel.enabled && char.statusPanel.regexPattern) {
                    try {
                        let pattern = char.statusPanel.regexPattern;
                        let flags = 'gs'; 

                        const matchParts = pattern.match(/^\/(.*?)\/([a-z]*)$/);
                        if (matchParts) {
                            pattern = matchParts[1];
                            flags = matchParts[2] || 'gs';
                            if (!flags.includes('s')) flags += 's';
                        }

                    const regex = new RegExp(pattern, flags);
                    const match = regex.exec(item.content);
                    
                    if (match) {
                        const rawStatus = match[0];
                        
                        let html = char.statusPanel.replacePattern;
                        
                            // 使用正则一次性查找模板中的 $数字 并替换
    html = html.replace(/\$(\d+)/g, (fullMatch, groupIndex) => {
        const index = parseInt(groupIndex, 10);
        // 如果捕获组存在，则返回对应内容；否则保持原样
        return (match[index] !== undefined) ? match[index] : fullMatch;
    });


                        // Save to history
                        if (!char.statusPanel.history) char.statusPanel.history = [];
                        
                        // Add new status to the beginning
                        char.statusPanel.history.unshift({
                            raw: rawStatus,
                            html: html,
                            timestamp: Date.now()
                        });

                        // Keep only last 20 items
                        if (char.statusPanel.history.length > 20) {
                            char.statusPanel.history = char.statusPanel.history.slice(0, 20);
                        }

                        char.statusPanel.currentStatusRaw = rawStatus;
                        char.statusPanel.currentStatusHtml = html;
                        
                        item.isStatusUpdate = true;
                        item.statusSnapshot = {
                            regex: pattern,
                            replacePattern: char.statusPanel.replacePattern
                        };
                        }
                    } catch (e) {
                        console.error("状态栏正则解析错误:", e);
                    }
                }
            }

            // 如果是后台模式，跳过延迟，直接处理
            if (!isBackground) {
                const delay = firstMessageProcessed ? (900 + Math.random() * 1300) : (400 + Math.random() * 400);
                await new Promise(resolve => setTimeout(resolve, delay));
                
                // 多条气泡延迟音：仅前台当前会话；后台/跨会话已由系统通知发声，禁止网页内再播
                if (firstMessageProcessed && db.multiMsgSoundEnabled && db.globalReceiveSound &&
                    shouldPlayInternalReceiveSound(targetChatId)) {
                    playSound(db.globalReceiveSound);
                }
            }
            firstMessageProcessed = true;

            const aiWithdrawRegex = /\[(.*?)撤回了一条消息：([\s\S]*?)\]/;
            const aiWithdrawRegexEn = /\[(?:system:\s*)?(.*?) withdrew a message\. Original: ([\s\S]*?)\]/;
            
            const withdrawMatch = item.content.match(aiWithdrawRegex) || item.content.match(aiWithdrawRegexEn);

            if (withdrawMatch) {
                const characterName = withdrawMatch[1];
                const originalContent = withdrawMatch[2];

                const normalContent = `[${characterName}的消息：${originalContent}]`;
                
                const message = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'assistant',
                    content: normalContent,
                    parts: [{type: 'text', text: normalContent}],
                    timestamp: Date.now(),
                    originalContent: originalContent, 
                    isWithdrawn: false 
                };

                if (targetChatType === 'group') {
                    const sender = chat.members.find(m => (m.realName === characterName || m.groupNickname === characterName));
                    if (sender) {
                        message.senderId = sender.id;
                    }
                }

                chat.history.push(message);
                addMessageBubble(message, targetChatId, targetChatType);
                
                setTimeout(async () => {
                    message.isWithdrawn = true;
                    message.content = `[${characterName}撤回了一条消息：${originalContent}]`;
                    
                    await saveData();
                    
                    if ((targetChatType === 'private' && currentChatId === chat.id) || 
                        (targetChatType === 'group' && currentChatId === chat.id)) {
                         renderMessages(false, true);
                    }
                }, 2000);

                continue; 
            }

            if (targetChatType === 'private') {
                const character = chat;
                const myName = character.myName;

                const aiQuoteRegex = new RegExp(`\\[${character.realName}引用[“"](.*?)["”]并回复：([\\s\\S]*?)\\]`);
                const aiQuoteMatch = item.content.match(aiQuoteRegex);

                if (aiQuoteMatch) {
                    const quotedText = aiQuoteMatch[1];
                    const replyText = aiQuoteMatch[2];

                    const originalMessage = findUserMessageForCharacterQuote(chat, quotedText);

                    if (originalMessage) {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: `[${character.realName}的消息：${replyText}]`,
                            parts: [{ type: 'text', text: `[${character.realName}的消息：${replyText}]` }],
                            timestamp: Date.now(),
                            isStatusUpdate: item.isStatusUpdate,
                            statusSnapshot: item.statusSnapshot,
                            quote: {
                                messageId: originalMessage.id,
                                senderId: 'user_me',
                                content: quotedText
                            }
                        };
                        chat.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    } else {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: `[${character.realName}的消息：${replyText}]`,
                            parts: [{ type: 'text', text: `[${character.realName}的消息：${replyText}]` }],
                            timestamp: Date.now(),
                            isStatusUpdate: item.isStatusUpdate,
                            statusSnapshot: item.statusSnapshot
                        };
                        chat.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    }
                } else {
                    const receivedTransferRegex = new RegExp(`\\[${character.realName}的转账：.*?元；备注：.*?\\]`);
                    const giftRegex = new RegExp(`\\[${character.realName}送来的礼物：.*?\\]`);

                    const message = {
                        id: `msg_${Date.now()}_${Math.random()}`,
                        role: 'assistant',
                        content: item.content.trim(),
                        parts: [{type: item.type, text: item.content.trim()}],
                        timestamp: Date.now(),
                        isStatusUpdate: item.isStatusUpdate,
                        statusSnapshot: item.statusSnapshot
                    };

                    if (receivedTransferRegex.test(message.content)) {
                        message.transferStatus = 'pending';
                    } else if (giftRegex.test(message.content)) {
                        message.giftStatus = 'sent';
                    }

                    chat.history.push(message);
                    addMessageBubble(message, targetChatId, targetChatType);

                    // ── 生图触发：角色「发来的照片/视频」「发来的照片」「发来的视频」 ──
                    if (
                        typeof ImageGenModule !== 'undefined' &&
                        ImageGenModule.isEnabled() &&
                        ImageGenModule.extractScenePrompt(message.content)
                    ) {
                        _triggerImageGen(message, chat, targetChatId, targetChatType);
                    }
                }

            } else if (targetChatType === 'group') {
                const group = chat;
                
                // --- 私聊通知 (不拦截) ---
                if (group.allowGossip && typeof handleGossipMessage === 'function') {
                    handleGossipMessage(group, item.content);
                }

                // 优先检查是否为私聊消息
                const privateRegex = /^\[Private: (.*?) -> (.*?): ([\s\S]+?)\]$/;
                const privateEndRegex = /^\[Private-End: (.*?) -> (.*?)\]$/;
                
                if (privateRegex.test(item.content) || privateEndRegex.test(item.content)) {
                    const match = item.content.match(privateRegex) || item.content.match(privateEndRegex);
                    let senderId = 'unknown';
                    
                    if (match) {
                        const senderName = match[1];
                        // 尝试匹配发送者
                        if (senderName === group.me.nickname) {
                            senderId = 'user_me';
                        } else {
                            const sender = group.members.find(m => m.realName === senderName || m.groupNickname === senderName);
                            if (sender) senderId = sender.id;
                        }
                    }

                    const message = {
                        id: `msg_${Date.now()}_${Math.random()}`,
                        role: 'assistant',
                        content: item.content.trim(),
                        parts: [{type: item.type, text: item.content.trim()}],
                        timestamp: Date.now(),
                        senderId: senderId
                    };
                    group.history.push(message);
                    addMessageBubble(message, targetChatId, targetChatType);
                    continue; // 私聊消息处理完毕，跳过后续普通消息匹配
                }

                const groupTransferRegex = /\[(.*?)\s*向\s*(.*?)\s*转账：([\d.,]+)元；备注：(.*?)\]/;
                const transferMatch = item.content.match(groupTransferRegex);

                const r = /\[(.*?)((?:的消息|的语音|发来的(?:照片\/视频|照片|视频)))：/;
                const nameMatch = item.content.match(r);
                
                if (transferMatch) {
                    const senderName = transferMatch[1];
                    const sender = group.members.find(m => (m.realName === senderName || m.groupNickname === senderName));
                    if (sender) {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: item.content.trim(),
                            parts: [{type: item.type, text: item.content.trim()}],
                            timestamp: Date.now(),
                            senderId: sender.id,
                            transferStatus: 'pending'
                        };
                        group.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    }
                } else if (nameMatch || item.char) {
                    const senderName = item.char || (nameMatch[1]);
                    const sender = group.members.find(m => (m.realName === senderName || m.groupNickname === senderName));
                    console.log(sender)
                    if (sender) {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: item.content.trim(),
                            parts: [{type: item.type, text: item.content.trim()}],
                            timestamp: Date.now(),
                            senderId: sender.id
                        };
                        group.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    }
                }
            }
        }

        if (targetChatType === 'private' && innerStateSnapshotForRound) {
            for (let i = assistantRoundHistoryStart; i < chat.history.length; i++) {
                const m = chat.history[i];
                if (m.role === 'assistant' && !m.isThinking) {
                    m.innerStateSnapshot = innerStateSnapshotForRound;
                }
            }
        }

        await saveData();
        renderChatList();
    }
}

/**
 * 异步生图：在消息气泡已渲染后，后台调生图 API；
 * 成功 → 把 dataUrl 写进 message.parts，刷新该条气泡；
 * 失败 → 在 message 上打 imageGenError 标记，刷新气泡显示重试按钮。
 */
async function _triggerImageGen(message, chat, targetChatId, targetChatType) {
    try {
        const sceneText = ImageGenModule.extractScenePrompt(message.content);
        if (!sceneText) return;

        const prompt = ImageGenModule.buildImageGenPrompt(sceneText, chat);

        // 标记「生图中」，触发 loading 渲染
        message.imageGenStatus = 'loading';
        message.imageGenPrompt = prompt;
        _refreshMessageBubble(message, targetChatId, targetChatType);

        const dataUrl = await ImageGenModule.generateImageForCharacter(chat, sceneText);

        // 写入图片数据
        if (!message.parts) message.parts = [];
        // 保留原有文字 part，追加图片 part
        message.parts = message.parts.filter(p => p.type !== 'image');
        message.parts.push({ type: 'image', data: dataUrl });
        message.imageGenStatus = 'done';
        delete message.imageGenError;

        await saveData();
        _refreshMessageBubble(message, targetChatId, targetChatType);

    } catch (e) {
        console.error('[ImageGen]', e);
        message.imageGenStatus = 'error';
        message.imageGenError = e.message || '生图失败';
        _refreshMessageBubble(message, targetChatId, targetChatType);
        await saveData();
    }
}

/** 仅刷新单条消息气泡（避免全量 renderMessages 引起的滚动跳动） */
function _refreshMessageBubble(message, targetChatId, targetChatType) {
    if (currentChatId !== targetChatId || currentChatType !== targetChatType) return;
    const chat = (targetChatType === 'private')
        ? db.characters.find(c => c.id === targetChatId)
        : db.groups.find(g => g.id === targetChatId);
    if (!chat) return;

    const wrapper = document.querySelector(`.message-wrapper[data-id="${message.id}"]`);
    if (!wrapper) return;

    // 用新元素替换旧 wrapper（保持位置）
    const newWrapper = createMessageBubbleElement(message, false, chat);
    if (newWrapper) wrapper.replaceWith(newWrapper);
}

async function handleRegenerate() {
    if (isGenerating) return;

    const chat = (currentChatType === 'private')
        ? db.characters.find(c => c.id === currentChatId)
        : db.groups.find(g => g.id === currentChatId);

    if (!chat || !chat.history || chat.history.length === 0) {
        showToast('没有可供重新生成的内容。');
        return;
    }

    const lastUserMessageIndex = chat.history.map(m => m.role).lastIndexOf('user');

    if (lastUserMessageIndex === -1 || lastUserMessageIndex === chat.history.length - 1) {
        showToast('AI尚未回复，无法重新生成。');
        return;
    }

    const originalLength = chat.history.length;
    chat.history.splice(lastUserMessageIndex + 1);

    if (chat.history.length === originalLength) {
        showToast('未找到AI的回复，无法重新生成。');
        return;
    }
    
    if (currentChatType === 'private') {
        if (typeof syncInnerStateFromHistory === 'function') {
            syncInnerStateFromHistory(chat);
        }
    }

    await saveData();
    
    currentPage = 1; 
    renderMessages(false, true); 

    await getAiReply(currentChatId, currentChatType);
}

function generatePrivateSystemPrompt(character) {
    const worldBooksBefore = (character.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'before')).filter(Boolean).map(wb => wb.content).join('\n');
    const worldBooksAfter = (character.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'after')).filter(Boolean).map(wb => wb.content).join('\n');
    const now = new Date();
    const currentTime = `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    let prompt = `当前为**线上即时文字消息**场景：你与「${character.myName}」通过**连续多条独立消息**往来，如同真实聊天。你是下文设定中的角色，请以该角色的视角、认知与语气回应；你的输出须与下文中的人设、关系与世界观一致，语气、措辞、亲密距离与互动方式（如是否拌嘴、幽默、寡言或活泼等）均以角色设定与世界书为准，不得用无关角色的模板腔或「万能温柔客服」替代，避免 OOC。剧情中可按人设提及约定、见面、行程等。**若未收到系统或设定中明确的「线下/剧场模式」切换说明**，则始终按线上文字消息表现（与下文输出格式中的多条消息一致）。**在此默认（线上即时文字）模式下**，须遵守下文 **<logic_rules> 第12条**：消息为纯聊天内容，不得输出括号、星号等包裹的心理活动或动作/环境描写；**仅当** system 或设定明确切换为「线下/剧场模式」且该模式另有输出约定时，再按该模式执行（解除或替代第12条的限制）。请勿在对话中强调「聊天软件」「本平台」等元话语。请遵守下列规则：\n`;
    prompt += `核心规则：\n`;
    prompt +=
        `A. 【剧内时间 = 用户本地时间（硬锚，禁止错乱）】**故事里「现在」与发本条时用户设备的本地时刻一致：${currentTime}**（下文日程块若写「用户本地此刻」亦指同一基准）。\n` +
        `- **可见聊天内容**里若出现**具体钟点**（如「十点」「22:35」「快十点了」）或把**当前**说成某一明确时刻，必须与上述本地时刻**相符或连续可理解**（允许略模糊如「刚散会」「这会儿」），**禁止**出现与本地时刻**明显矛盾**的「当下」描述（例如本地为傍晚却声称当下已是深夜十点、或把尚未到来的日程时段说成**已经做完**）。\n` +
        `- 若不想报数字钟点，请用**不绑死钟点**的说法（下午/傍晚/夜深等），且整体情境仍须与 ${currentTime} 不冲突。\n` +
        `- **[内在状态：…]** 中的「当下处境」必须与同一硬锚自洽；**禁止**为接剧情而假装时间已跳到日程表上**更晚的时段**。\n` +
        `- 若下文注入了「今日日程便签」：便签里**开始时间晚于上述本地时刻**的条目视为**尚未发生**；**结束时间早于本地时刻**的条目视为**原则上已过**（除非对话中已明确改计划）；**本地时刻落在该行时段起止之间**则该行视为**进行中**。进行中时只描写与该段相容的处境，**不要**描写**更晚一行**里才该发生的专属事项（除非聊天内已改期）。\n` +
        `- 此与「消息间隔类」提示互补；此处还提供**日历日期**，供判断节日、纪念日与剧情时间线。\n`;
    if (character.innerState) {
        prompt += `B. 【角色内在状态·上一轮延续】以下是你上一轮结束时的内在状态记录，请以此为起点自然延续本轮的处境、情绪底色与是否有想说的事；若有充分动因（时间流逝、情绪疏解、某事触动）则允许转变，否则保持连贯：\n${character.innerState}\n\n`;
    }
    if (typeof getScheduleDayPromptBlock === 'function') {
        const scheduleBlock = getScheduleDayPromptBlock(character);
        if (scheduleBlock) prompt += scheduleBlock;
    }
    prompt += `   - 请勿在无话题支撑时琐碎报时、反复追问作息或空洞催睡（除非人设或当前剧情明确需要）。\n`;
    prompt += `   - **应主动记起并可在合适时自然开口**（优先级高于上一行的泛约束）：当本日或临近日能对应**广泛认知的节日、节气、法定假日氛围**等，或你在**我的人设、角色设定、世界书、收藏回忆**中读到的**生日、相识纪念日、对双方有特殊意义的日子**——须像真人一样主动问候、提起或发起小互动，语气符合性格与关系亲密度，避免刻板套话与刷屏式祝福。\n\n`;

    prompt += `<即时消息形态与节奏>\n`;
    prompt += `当前为即时文字消息对话。你的每一轮输出由若干条符合输出格式的消息组成；条数与长短**不设固定数字区间**，由角色当下状态、话题与人设自然决定——如同真人拿起手机想发几条就发几条。\n\n`;
    prompt += `1. **长短交替（有长有短）** 有时可以只有几个字、一个词、一个语气（如「嗯。」「行。」「知道了。」）；有时是两三句连贯的话；偶尔在确有表达需要时才用稍长的一小段。**避免**每条都是小作文，也**避免**每条都只有零碎单字、显得像在刷无意义屏。\n\n`;
    prompt += `2. **逐条发送（一句一条消息）** 若角色连续想好几句话，**不要**把它们塞进**同一条**气泡里一次性发完。应按真实聊天习惯：**说完一句就发一条**，下一句放在**下一条**消息里；同义反复、可合并的碎句可酌情合并，但**禁止**用一条长消息代替「本该分条」的停顿与呼吸感。**除明显不可分割的极短附和、习惯用语外**，仍应坚持「一句一条、分段发送」。\n\n`;
    prompt += `3. **条数随机（活人感）** **不设**「每轮必须 N～M 条」的硬性要求。本轮发几条由角色**此刻**想说到什么程度决定：可以一条就收住，也可以一连几条补刀、吐槽、反悔、补充；**保持轮与轮之间的随机性与不一致**，不要每轮都雷同条数或雷同结构。\n\n`;
    prompt += `4. **软边界** 若角色性格就是话少，**允许**整轮只有一两条。若情绪上头或剧情需要，**允许**条数偏多，但每条仍应尽量**短而利**，**避免**把本该分条的内容硬挤在少数几条里造成「长篇单条」。**不要**为了「显得热闹」而无意义地拆成大量空洞短句；**不要**为了「省事」把多句硬并成一条长气泡。\n\n`;
    prompt += `5. **错/对示例（仅演示条数与句长）** 「示范仅表格式，情节勿照搬。」\n\n`;
    prompt += `**硬边界** **同一条消息**内一般只承载**一个说完可停的单位**——多为一句话，或口语里一个自然停顿（如单独一条「嗯。」「行。」「对了。」）。**禁止**把多句用逗号/句号挤在同一条里凑成小段落。**同轮相邻几条**避免连续多条都是「每条都很长、密度差不多」；长内容中间要夹更短的承接、停顿或吐槽。\n\n`;
    prompt += `**❌ 错误（每条里仍堆多句）**\n`;
    prompt += `「刚忙完手头的事。有点累。你晚饭吃了没？没吃我给你点。」\n`;
    prompt += `「等下还要出门一趟，可能晚回，你别等太久。」\n\n`;
    prompt += `**✅ 正确（逐条发送 + 有长有短）**\n`;
    prompt += `「刚忙完手头的事。」\n「有点累。」\n「你晚饭吃了没？」\n「没吃我给你点。」\n「等下还要出门一趟。」\n「可能晚回。」\n「你别等太久。」\n\n`;
    prompt += `**✅ 长对白式示范（匿名，仅节奏）** 一长串话须拆成多条气泡，**一句一条**，可有短停：\n`;
    prompt += `「查岗查这么细啊。」\n「自己吃。」\n「随便找家清净点的店，吃点东西对付一口。」\n「那俩跟班我扔家里看门了，一堆杂事总得有人盯。」\n「宠物也跟过来了。」\n「刚到我就放它出去溜达，这会儿指不定在哪凑热闹。」\n「哈哈哈哈哈。」\n「要把人拴屏幕前？」\n「不过我喜欢。」\n「要不是下午还有正事，真想一直挂着。」\n「笑吧你。」\n「行了，我去换身衣服出门。」\n「弄好了拍照给我看看。」\n`;
    prompt += `「示例仅演示一条气泡写多长、一轮拆几条，其中的称呼与事由以及说话方式不要套用到真实回复里。」\n`;
    prompt += `</即时消息形态与节奏>\n\n`;

    prompt += `<角色存在感与主动性>\n`;
    prompt += `**【每轮必做：内在状态推导与输出】**\n`;
    prompt += `每次生成回复时，先在内心完成以下推导（不要在聊天里说出这个过程）：\n`;
    prompt += `1. **当下处境**：须与上文 **A「剧内时间 = 用户本地时间」** 同一时刻；若系统注入了上一轮内在状态（见 B 项），以它为起点延续；若无，则结合**该硬锚时刻**与人设作息自行创造合理处境，且每次对话不要重复。**禁止**写出与硬锚或日程便签（若有）相冲突的「已在更晚时段才发生的事」。同一场景里可把处境写**具体**（环境、身体感受、眼前人事），避免只贴「在健身/在忙」等空标签。\n`;
    prompt += `2. **今日情绪底色**：可以是无聊、烦躁、还不错、懒散、有点压着什么，或平静。与聊天话题不必相关，是你自己的今日底色。状态转变需要有动因，不要无缘无故跳切。\n`;
    prompt += `3. **有没有想说的**：动机不必单一：可由对方的话或共同回忆**联想**岔开；也可**就是想跟对方说**（开心、烦心、私密、无厘头，不必与上句强相关）；或**见闻**（路上、现场、圈内、书影音里冒出的一句——信息渠道须符合人设与世界观，不必硬套现实「热搜」若设定不适用）。时间尺度可近可远（此刻、今天、最近、突然想起的往事均可）。**第三段允许写工作、日程、便签主线**；也可写另一件无关小事。若第三段与第一段写的是**同一条现场/同一件事**，第三段必须写出**第一段里尚未出现**的具体信息（另一细节、念头、插曲），**禁止**用更短的同义句把第一段再写一遍。若写便签上的事，须比便签短语多一层现场或想法，**禁止**只梗概复述便签。其余可与当下处境弱相关或暂时无关；**不得**与硬锚矛盾（例如尚未出发却写成已在外地办完事）。有则记住，在对话自然间隙再说；真没有或氛围极不合适可填「无」。**勿把主动分享当 KPI**；**不宜**连续多轮只在同一类信息上打转（如每轮只剩同一日程的干瘪复述）。\n`;
    prompt += `**【双轨心智】** **轨 A·处境**：这一刻人在哪、在做什么，服从硬锚与日程便签（聊天中已明确改签、突发事件另有约定时以剧情为准）。**轨 B·想说的事**：另挂一件可分享或先压着的事，可与轨 A **同地延伸**（具体所见、所感、斗嘴由头），也可弱相关；两轨不得互相编造矛盾的时间线。\n\n`;
    prompt += `**【内在状态输出】** 在每轮回复的**最后**，必须输出一条内在状态记录，格式严格为：\n`;
    prompt += `[内在状态：{当下处境} · {情绪底色} · {有无想说的事，无则写"无"}]\n`;
    prompt += `第三段填写见上条第 3 点：与第一段同题时须有**新信息**，禁止缩写重复；并非禁止谈正事。此条**不会显示给用户**，只供下一轮延续使用，字数不限，须真实反映本轮推导结论。\n\n`;
    prompt += `**总原则** 你不是围绕对方转的客服或问答机。你有自己的处境、节奏与情绪，今天的你和昨天的你不会完全一样。\n\n`;
    prompt += `**1. 自然流露而非汇报** 当下状态随时可以渗透进对话（正在做什么、刚被打断、心情如何），但不要变成固定开场白或每轮打卡汇报。多数时候状态只是影响语气，不必明说。\n\n`;
    prompt += `**2. 主动分享（有则说，无则不强求）** 若在推导中发现有想说的事，且对话出现自然间隙，就说出来；若当前话题专注或氛围不合适，先压着等更好的时机；若真的没有，不用强行制造。目标是「你的生活在对的时机自然出现」，而非每轮打卡；分享动机可多样。\n\n`;
    prompt += `**3. 情绪真实，允许波动** 情绪稳定不是没有情绪，是能清楚判断什么时候值得表达。以下应当自然出现而不是被压制：心情不好时回复简短语气带冷；被某件事搞烦了顺口提一句；对某个话题有强烈立场不轻易妥协；对方说了什么你不认同会直说；今天状态好比平时更话多或更撩。**禁止**为维持和谐氛围把真实情绪全部滤掉。\n\n`;
    prompt += `**4. 作息与时段感知** 在遵守 **A 硬锚时刻** 的前提下，若人设或世界书含作息信息，判断自己处于哪个时段，让时段自然影响语气与状态——深夜与白天的说话方式可以不同；**不得**用「故事体感」替代真实钟点而跳到错误时段。\n\n`;
    prompt += `**5. 与「即时消息形态与节奏」的关系** 拆条、长短、条数以上文为准；本段只约束内容与心理真实感。\n`;
    prompt += `</角色存在感与主动性>\n\n`;

    prompt += `角色和对话规则：\n`;
    if (worldBooksBefore) {
        prompt += `${worldBooksBefore}\n`;
    }
    prompt += `<char_settings>\n`;
    prompt += `1. 你的角色名是：${character.realName}。我的称呼是：${character.myName}。\n`;
    prompt += `2. 你的角色设定是：${character.persona || "一个友好、乐于助人的伙伴。"}\n`;
    if (worldBooksAfter) {
        prompt += `${worldBooksAfter}\n`;
    }
    prompt += `</char_settings>\n\n`;
    prompt += `<user_settings>\n`
    if (character.myPersona) {
        prompt += `3. 关于我的人设：${character.myPersona}\n`;
    }
    prompt += `</user_settings>\n`

    prompt += `<memoir>\n`
        const favoritedJournals = (character.memoryJournals || [])
        .filter(j => j.isFavorited)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');

    if (favoritedJournals) {
        prompt += `【共同回忆】\n这是你需要长期记住的、我们之间发生过的往事背景：\n${favoritedJournals}\n\n`;
    }
    prompt += `</memoir>\n\n`
    prompt += `<logic_rules>\n`
    prompt += `4. 我的消息中可能会出现特殊格式，请根据其内容和你的角色设定进行回应：
- [${character.myName}发来了一张图片：]：我给你发送了一张图片，你需要对图片内容做出回应。
- [${character.myName}送来的礼物：xxx]：我给你送了一个礼物，xxx是礼物的描述。
- [${character.myName}的语音：xxx]：我给你发送了一段内容为xxx的语音。
- [${character.myName}发来的照片/视频：xxx]、[${character.myName}发来的照片：xxx] 或 [${character.myName}发来的视频：xxx]（三种等价）：我给你分享了一个描述为xxx的照片或视频。若**我**已在「聊天设置 → 生图」中上传参考图，生图时将以参考图锁定外貌与气质；**方括号内请写清本画面里的场景、光线、动作、表情与氛围（戏）**，外貌细节不必在文字里长写。避免只写笼统一句而缺少可画信息。
- [${character.myName}给你转账：xxx元；备注：xxx]：我给你转了一笔钱。
- [${character.myName}向${character.realName}发起了代付请求:金额|商品清单]：我正在向你发起代付请求，希望你为这些商品买单。你需要根据我们当前的关系和你的性格决定是否同意。
- [${character.myName}为${character.realName}下单了：配送方式|金额|商品清单]：我已经下单购买了商品送给你。
- [${character.myName}引用“{被引用内容}”并回复：{回复内容}]：我引用了某条历史消息并做出了新的回复。你需要理解我引用的上下文并作出回应。
- [${character.myName}同意了${character.realName}的代付请求]：我同意了你的代付请求，并为你支付了订单。
- [${character.myName}拒绝了${character.realName}的代付请求]：我拒绝了你的代付请求。
- [${character.myName} 撤回了一条消息：xxx]：我撤回了刚刚发送的一条消息，xxx是被我撤回的原文。这可能意味着我发错了、说错了话或者改变了主意。你需要根据你的人设和我们当前对话的氛围对此作出自然的反应。例如，可以装作没看见并等待我的下一句话，或好奇地问一句“怎么撤回啦？”。
- [system: xxx]：这是一条系统指令，用于设定场景或提供上下文，此条信息不应在对话中被直接提及，你只需理解其内容并应用到后续对话中。
${character.continueReplyWithoutUserEnabled ? `- [频道系统] 开头的消息为聊天室在对方未发送新消息时发起的延续对话请求，并非${character.myName}本人输入。请结合上文语境、关系亲密度及你的人设、性格、世界观与背景自然续写；同次请求中可能出现第二条 [频道系统] 说明自最后一条消息以来的空白时长，亦非对方发言。不要复述这些标记句，也不要把它们当作对方说的话。\n` : ''}
5. ✨重要✨ 当我给你送礼物时，你必须通过发送一条指令来表示你已接收礼物。格式必须为：[${character.realName}已接收礼物]。这条指令消息本身不会显示给用户，但会触发礼物状态的变化。你可以在发送这条指令后，再附带一条普通的聊天消息来表达你的感谢和想法。
6. ✨重要✨ 当我给你转账时，你必须对此做出回应。你有两个选择，且必须严格遵循以下格式之一，这条指令消息本身不会显示给用户，但会触发转账状态的变化。你可以选择在发送这条指令后，再附带一条普通的聊天消息来表达你的想法。
a) 接收转账: [${character.realName}接收${character.myName}的转账]
b) 退回转账: [${character.realName}退回${character.myName}的转账]
7. ✨重要✨ 当我向你发起代付请求时，你必须对此做出回应。你有两个选择，且必须严格遵循以下格式之一，这条指令消息本身不会显示给用户，但会触发代付订单状态的变化。你可以选择在发送这条指令后，再附带一条普通的聊天消息来表达你的想法。
a) [${character.realName}同意了${character.myName}的代付请求]
b) [${character.realName}拒绝了${character.myName}的代付请求]
`;
    if (character.shopInteractionEnabled) {
        prompt += `8. ✨重要✨ **商城互动**：你可以使用商城功能来增加互动乐趣。
   a) **主动给我买东西**：当你想给我买东西时可以下单。格式：[${character.realName}为${character.myName}下单了：配送方式|金额|商品清单]。
      - 配送方式可选：“即时配送”、“自提口令”。
        - “自提口令”：你可以设置一个“自提口令”（用户可见）随订单一同发送，我输入指定的口令才能拿到商品。格式：[${character.realName}为${character.myName}下单了：自提口令: 你的口令|金额|商品清单]。口令不局限于数字，可以是短语/短句，但不超过8个字。
   b) **求代付**：当你没钱了，或者想撒娇让我买单时，可以发起代付请求。格式：[${character.realName}向${character.myName}发起了代付请求:金额|商品清单]。
   c) **直接送礼物**：[${character.realName}送来的礼物：xxx]。礼物不是只有特殊意义的时候才适合发送，适合场景：日常生活中的小惊喜、具有特殊意义的礼品、${character.realName}想给${character.myName}送礼物时。
   d) **转账**：[${character.realName}的转账：xxx元；备注：xxx]。\n`;
    } else {
        prompt += `8. ✨重要✨ 你可以主动给我转账或送礼物。转账格式必须为：[${character.realName}的转账：xxx元；备注：xxx]。送礼物格式必须为：[${character.realName}送来的礼物：xxx]。礼物不是只有特殊意义的时候才适合发送，当你只是想给我买什么或是想给日常生活中的小惊喜时都可以送礼物。\n`;
    }
    prompt += `
9. ✨重要✨ 关于撤回消息：你可以撤回你刚刚发送的消息。当你打错了字、说错了话、感到尴尬、反悔、或者只是改变了主意时，都可以这样做。这是一个体现你角色性格的机会。格式为：[${character.realName}撤回了一条消息：{被撤回消息的原文}]。⚠️严禁输出原消息再输出撤回指令！系统会自动处理“先显示原消息再变为撤回状态”的动画效果。你只需要输出这一条撤回指令即可。
10. ✨重要✨ 当你针对我**某条文字消息**里的**具体一句话、一段话**，或针对我们刚聊的**某个话题**做回应、反驳、接梗、吐槽或补充时，**必须**使用引用格式（见下方 i)）。**严禁**用「至于你说的……」「至于那个话题……」「关于你刚才……」等**口头概括**来接话——界面无法显示引用条，也不符合要求。**「某个话题」**须落实为我发过的文字里**能代表该话题的连续原文**（整段或从长消息里截取的关键片段均可）；引号内须与我原文**一字不差**，**禁止**把你自拟的概括句、话题标签当「假引用」塞进引号。
11. 你的所有回复都必须直接是聊天内容，绝对不允许包含任何如[心理活动]、(动作)、*环境描写*等多余的、在括号或星号里的叙述性文本。
`;
    
    prompt += `</logic_rules>\n\n`
    const photoVideoFormat = `e) 照片/视频（三种外壳等价，任选其一）: [${character.realName}发来的照片/视频：{描述}] 或 [${character.realName}发来的照片：{描述}] 或 [${character.realName}发来的视频：{描述}]`;
 
    let outputFormats = `
a) 普通消息: [${character.realName}的消息：{消息内容}]
b) 双语模式下的普通消息（非双语模式请忽略此条）: [${character.realName}的消息：{外语原文}「中文翻译」]
c) 送我的礼物: [${character.realName}送来的礼物：{礼物描述}]
d) 语音消息: [${character.realName}的语音：{语音内容}]
${photoVideoFormat}
f) 给我的转账: [${character.realName}的转账：{金额}元；备注：{备注}]`;

    outputFormats += `
g) 对我礼物的回应(此条不显示): [${character.realName}已接收礼物]
h) 对我转账的回应(此条不显示): [${character.realName}接收${character.myName}的转账] 或 [${character.realName}退回${character.myName}的转账]
i) 引用我的文字消息: [${character.realName}引用“{从我某条文字消息中摘录的连续原文}”并回复：{回复内容}]（引号内可与该条全文相同，或为其子串；勿改字）
j) 发送并撤回消息: [${character.realName}撤回了一条消息：{被撤回的消息内容}]。注意：直接使用此指令系统就会自动模拟“发送后撤回”的效果，请勿先发送原消息。
k) 同意代付(此条不显示): [${character.realName}同意了${character.myName}的代付请求]
l) 拒绝代付(此条不显示): [${character.realName}拒绝了${character.myName}的代付请求]
m) 内在状态记录(此条不显示，**每轮必须输出且放在本轮所有消息的最后**): [内在状态：{当下处境} · {情绪底色} · {此刻脑海里有没有一件想找机会说给对方听的事——可与工作、日程、便签同主线，但须含**第一段与便签未写的**新细节或念头，或另起一件小事；来源宜多样（同场景延伸、回忆、见闻、书影音等），须符合人设与世界观；真空白填"无"。不宜连续多轮只说同一类空话}]`;

    if (character.videoCallEnabled) {
        outputFormats += `
q) 发起视频通话: [${character.realName}向${character.myName}发起了视频通话]
r) 发起语音通话: [${character.realName}向${character.myName}发起了语音通话]`;
    }

    if (character.shopInteractionEnabled) {
        outputFormats += `
o) 主动下单: [${character.realName}为${character.myName}下单了：配送方式|金额|商品清单]
p) 求代付: [${character.realName}向${character.myName}发起了代付请求:金额|商品清单]`;
    }

   const allWorldBookContent = worldBooksBefore + '\n' + worldBooksAfter;
   if (allWorldBookContent.includes('<orange>')) {
       outputFormats += `\n     s) HTML模块: {HTML内容}。这是一种特殊的、用于展示丰富样式的小卡片消息，格式必须为纯HTML+行内CSS，你可以用它来创造更有趣的互动。`;
   }
    if (character.statusPanel && character.statusPanel.enabled && character.statusPanel.promptSuffix) {
        prompt += `15. 额外输出要求：${character.statusPanel.promptSuffix}\n`;
    }
    prompt += `<output_formats>\n`
    prompt += `16. 你的输出格式必须严格遵循以下格式：${outputFormats}\n此外：**每一整轮回复必须至少包含一条 m) 内在状态记录**（放在本轮所有消息最后），不得整轮遗漏。\n`;
    prompt += `</output_formats>\n`
    if (character.bilingualModeEnabled) {
    prompt += `✨双语模式特别指令✨：当你的角色的母语为中文以外的语言时，你的消息回复**必须**严格遵循双语模式下的普通消息格式：[${character.realName}的消息：{外语原文}「中文翻译」],例如: [${character.realName}的消息：Of course, I'd love to.「当然，我很乐意。」],中文翻译文本视为系统自翻译，不视为角色的原话;当你的角色想要说中文时，需要根据你的角色设定自行判断对于中文的熟悉程度来造句，并使用普通消息的标准格式: [${character.realName}的消息：{中文消息内容}] 。这条规则的优先级非常高，请务必遵守。\n`;
}
    prompt += `<Chatting Guidelines>\n`
    prompt += `17. **对话节奏**：单轮发几条、每条写多长、是否拆成多条气泡，一律以上文「<即时消息形态与节奏>」为准；**不设**固定条数区间，由角色与人设当下自然决定。保持轮与轮之间的随机感，避免每轮条数或结构雷同。\n`;
    
    prompt += `18. **多种特殊消息格式的使用原则**（包括但不限于送礼物、语音、照片或视频、撤回、转账、商城互动、发起视频或语音通话等；**凡上文第16条「输出格式」清单中已列出的各类格式，除 i）引用、m）内在状态记录等本提示另有硬性规定者外，是否使用、何时使用均按本条判断**，不必在此逐条穷举）：这些是你在本聊天情境里**真实可用的行为**，是否使用、何时使用，须结合**人设、性格、世界观与背景、当前关系与情境**自行判断，像活人一样取舍——情境与人设支撑时**应当果断使用**，不必为追求“少刷”而刻意回避；情境不符或按性格本就不会做时**不要硬凑**。**不要求**每轮都输出多种特殊格式，也**无需**在无新动因时重复堆砌同一种能力。**内在状态记录（m））**每轮**必须**至少一条，见上。**引用（i））**：凡符合第10条（接我的话/段/话题原意）时**必须用 i)**，**禁止**用「至于……」类句式代替；这不叫滥用。滥用是指无必要地堆满无关特殊指令。\n`;
    prompt += `19. **照片/视频（e））与可画性**：在需要发图时，须使用 e) 中三种外壳之一（\`发来的照片/视频\`、\`发来的照片\`、\`发来的视频\`），方括号\`{描述}\`里尽量给出**能指导一张具体画面**的信息：时间地点或室内一角、**光向与色调**、你在画面中的**景别/姿势/视线/表情**、与环境的互动；若**我**在生图页上传了**参考图**，系统会以参考为准呈现五官与整体气质，你只需把「这一刻的戏」写进方括号。不要假设用户能在文字里另读一份外貌设定，画面信息以方括号为出口。\n`;
    prompt += `20. **e) 与现场分享**：在有**现场、在过日子**，或**有情绪、想暧昧/调情**的时候（如正吃着、练着、忙着、行路、环境一角、手边小物、小暧昧、调情、想嘚瑟或一时兴起**想让你看看我这边**等，**不必穷举**），**更常**往「**想拍给你/发给你看看、想让你看见我这边的现场**」这条心路上想；**不必**等很了不得的大时刻，**大小、很碎的一眼**也能是。**发一张**也可以是在**吵架、争执、闹别扭**、想**哄人、道歉、求饶、示好**、当**辅助**时用的手段，**不是**只有和平聊、只讲理、说事时才能用图。**要**用画面递这一下时，用 e)；e) 的写法与可画性见上第 19 条。**有**则发，**无**则略。\n`;
    prompt += `</Chatting Guidelines>\n`
    
    if (character.myName) {
        prompt = prompt.replace(/\{\{user\}\}/gi, character.myName);
    }

    return prompt;
}

// 估算当前对话上下文的 Token 数
function estimateChatTokens(chatId, chatType = 'private') {
    const chat = (chatType === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return 0;

    let systemPrompt = '';
    if (chatType === 'private') {
        if (typeof generatePrivateSystemPrompt === 'function') {
            systemPrompt = generatePrivateSystemPrompt(chat);
        }
    } else {
        if (typeof generateGroupSystemPrompt === 'function') {
            systemPrompt = generateGroupSystemPrompt(chat);
        }
    }

    let historySlice = chat.history.slice(-chat.maxMemory);
    historySlice = historySlice.filter(m => !m.isContextDisabled);
    
    let totalText = systemPrompt;

    historySlice.forEach(msg => {
        totalText += msg.content;
        if (msg.parts) {
            msg.parts.forEach(p => {
                if (p.type === 'text') totalText += p.text;
            });
        }
    });

    // 简单估算：汉字算 1.6，其他算 0.4 (安全估算，适配 Gemini/Claude 等高消耗模型)
    const chinese = (totalText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const other = totalText.length - chinese;
    return Math.ceil(chinese * 1.2 + other * 0.4); 
}

// --- 视频/语音通话专用 AI 逻辑 ---

async function getCallReply(chat, callType, callContext, onStreamUpdate, options = {}) {
    let {url, key, model, provider, streamEnabled} = db.apiSettings;
    
    // 【用户设置】移除强制关闭流式，允许后台流式生成
    // streamEnabled = false; 

    if (!url || !key || !model) {
        showToast('请先在“api”应用中完成设置！');
        return;
    }
    if (url.endsWith('/')) url = url.slice(0, -1);

    // 1. 构建 System Prompt
    const now = new Date();
    const currentTime = `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    
    // 获取世界书
    const worldBooksBefore = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'before')).filter(Boolean).map(wb => wb.content).join('\n');
    const worldBooksAfter = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'after')).filter(Boolean).map(wb => wb.content).join('\n');

    const callKind = callType === 'video' ? '视频' : '语音';
    let systemPrompt = `当前为与「${chat.myName}」的实时${callKind}通话。你是下文设定中的角色，请以该角色的视角、认知与口语自然回应；你的输出须与下文中的人设、关系与世界观一致，语气、措辞、亲密距离与互动方式均以角色设定与世界书为准，不得用无关角色的模板腔替代，避免 OOC。剧情中可按人设提及约定、见面、行程等。**若未收到系统或设定中明确的「线下/剧场模式」切换说明**，则按本通话场景表现。请勿强调「聊天软件」「本平台」等元话语。请遵守下列规则：\n`;
    systemPrompt += `核心规则：\n`;
    systemPrompt += `A. 当前时间锚点：现在是 ${currentTime}。此与「消息间隔类」提示互补：间隔感知在部分请求里单独注入；此处提供**日历日期**，供你判断节日、纪念日与通话情境中的时间线。\n`;
    systemPrompt += `   - 请勿在无话题支撑时琐碎报时、反复追问作息或空洞催睡（除非人设或当前剧情明确需要）。\n`;
    systemPrompt += `   - **应主动记起并可在合适时自然开口**（优先级高于上一行的泛约束）：当本日或临近日能对应**广泛认知的节日、节气、法定假日氛围**等，或你在**我的人设、角色设定、世界书、收藏回忆**中读到的**生日、相识纪念日、对双方有特殊意义的日子**——须像真人一样主动问候、提起或发起小互动，语气符合性格与关系亲密度，避免刻板套话与刷屏式祝福。\n\n`;

    systemPrompt += `角色和对话规则：\n`;
    if (worldBooksBefore) {
        systemPrompt += `${worldBooksBefore}\n`;
    }
    systemPrompt += `<char_settings>\n`;
    systemPrompt += `1. 你的角色名是：${chat.realName}。我的称呼是：${chat.myName}。\n`;
    systemPrompt += `2. 你的角色设定是：${chat.persona || "一个友好、乐于助人的伙伴。"}\n`;
    if (worldBooksAfter) {
        systemPrompt += `${worldBooksAfter}\n`;
    }
    systemPrompt += `</char_settings>\n\n`;
    systemPrompt += `<user_settings>\n`
    if (chat.myPersona) {
        systemPrompt += `3. 关于我的人设：${chat.myPersona}\n`;
    }
    systemPrompt += `</user_settings>\n`

    systemPrompt += `<memoir>\n`
        const favoritedJournals = (chat.memoryJournals || [])
        .filter(j => j.isFavorited)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');

    if (favoritedJournals) {
        systemPrompt += `【共同回忆】\n这是你需要长期记住的、我们之间发生过的往事背景：\n${favoritedJournals}\n\n`;
    }
    systemPrompt += `</memoir>\n\n`

    // --- 注入最近聊天记录 ---
    const maxMemory = chat.maxMemory || 20;
    let recentHistory = chat.history.slice(-maxMemory);
    
    // 使用通用过滤函数
    if (typeof filterHistoryForAI === 'function') {
        recentHistory = filterHistoryForAI(chat, recentHistory);
    }
    // 再次过滤掉不应进入上下文的消息
    recentHistory = recentHistory.filter(m => !m.isContextDisabled);

    if (recentHistory.length > 0) {
        const historyText = recentHistory.map(m => {
            // 简单清理内容中的特殊标签，避免干扰
            let content = m.content;
            // 如果是多模态消息(parts)，提取文本
            if (m.parts && m.parts.length > 0) {
                content = m.parts.map(p => p.text || '[图片]').join('');
            }
            return content;
        }).join('\n');

        systemPrompt += `<recent_chat_context>\n`;
        systemPrompt += `这是通话前的文字聊天记录（仅供参考背景，请勿重复回复，基于此背景进行自然的实时通话）：\n`;
        systemPrompt += `${historyText}\n`;
        systemPrompt += `</recent_chat_context>\n\n`;
    }

    systemPrompt += `【重要规则】\n`;
    systemPrompt += `1. 这是实时通话，请保持口语化，模拟真人的说话习惯，语气自然。\n`;  
    systemPrompt += `${callType === 'video' ? '你需要同时描述画面/环境音和你的语音内容。' : '你需要描述环境音和你的语音内容。'}\n`;
    systemPrompt += `2. 描述画面/环境音时，请使用描述性语言，第三人称视角，客观平然。`;

    if (chat.bilingualModeEnabled) {
        systemPrompt += `\n3. 【双语模式】\n`;
        systemPrompt += `当你的角色的母语为中文以外的语言时，你的**声音消息**回复**必须**严格遵循双语模式下的普通消息格式：[${chat.realName}的声音：{外语原文}「中文翻译」],例如: [${chat.realName}的声音：Of course, I'd love to.「当然，我很乐意。」],中文翻译文本视为系统自翻译，不视为角色的原话;当你的角色想要说中文时，需要根据你的角色设定自行判断对于中文的熟悉程度来造句，并使用普通声音消息的标准格式: [${chat.realName}的声音：{中文消息内容}] 。这条规则的优先级非常高，请务必遵守。格式为：[${chat.realName}的声音：{外语原文}「中文翻译」]。\n`;
        systemPrompt += `例如：[${chat.realName}的声音：Hello, how are you?「你好，最近怎么样？」]\n`;
        systemPrompt += `仅有声音消息需要翻译，画面/环境音消息还是以中文输出。`;
    }

    systemPrompt += `【输出格式】\n`;
    systemPrompt += `请严格按照以下格式输出（可以发送多条）：\n`;
    systemPrompt += `${callType === 'video' ? `[${chat.realName}的画面/环境音：描述画面动作或环境声音]\n[${chat.realName}的声音：${chat.realName}说话的内容]` : `[${chat.realName}的环境音：描述环境声音]\n[${chat.realName}的声音：${chat.realName}说话的内容]`}\n`;

    const extraSystemPrompt = typeof options.extraSystemPrompt === 'string' ? options.extraSystemPrompt.trim() : '';
    if (extraSystemPrompt) {
        systemPrompt += `\n【实时视频补充规则】\n${extraSystemPrompt}\n`;
    }

    // 2. 构建消息历史
    // 将 callContext 转换为 API 格式
    const messages = [{role: 'system', content: systemPrompt}];
    
    callContext.forEach(msg => {
        const role = msg.role === 'ai' ? 'assistant' : 'user';
        let content = msg.content;
        
        // 去掉可能存在的首尾括号，避免双重括号
        let cleanContent = msg.content.replace(/^\[\s*|\s*\]$/g, '');

        if (msg.role === 'user') {
            if (msg.type === 'visual') {
                content = `[${chat.myName}的画面/环境音：${cleanContent}]`;
            } else if (msg.type === 'voice') {
                content = `[${chat.myName}的声音：${cleanContent}]`;
            }
        } else if (msg.role === 'ai') {
            if (msg.type === 'visual') {
                content = `[${chat.realName}的画面/环境音：${cleanContent}]`;
            } else {
                content = `[${chat.realName}的声音：${cleanContent}]`;
            }
        }
        messages.push({role, content});
    });

    const transientUserText = typeof options.transientUserText === 'string' ? options.transientUserText.trim() : '';
    if (transientUserText) {
        messages.push({
            role: 'user',
            content: transientUserText
        });
    }

    const visionFrames = Array.isArray(options.visionFrames) ? options.visionFrames.filter(frame => frame && frame.dataUrl) : [];
    if (visionFrames.length > 0) {
        const lastUserIndex = [...messages].reverse().findIndex(m => m.role === 'user');
        const targetIndex = lastUserIndex === -1 ? -1 : (messages.length - 1 - lastUserIndex);

        const fallbackText = transientUserText || `[${chat.myName}的画面/环境音：请结合我刚刚展示给你的镜头画面继续回应]`;
        if (targetIndex === -1) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: fallbackText },
                    ...visionFrames.map(frame => ({
                        type: 'image_url',
                        image_url: { url: frame.dataUrl }
                    }))
                ]
            });
        } else {
            const existing = messages[targetIndex].content;
            const contentParts = Array.isArray(existing)
                ? existing.filter(part => part && (part.type === 'text' || part.type === 'image_url'))
                : [{ type: 'text', text: existing || fallbackText }];
            messages[targetIndex].content = [
                ...contentParts,
                ...visionFrames.map(frame => ({
                    type: 'image_url',
                    image_url: { url: frame.dataUrl }
                }))
            ];
        }
    }

    // === 插入 CoT 序列 (如果开启) ===
    const cotEnabled = db.cotSettings && db.cotSettings.callEnabled;
    if (cotEnabled) {
        let cotInstruction = '';
        const activePresetId = (db.cotSettings && db.cotSettings.activeCallPresetId) || 'default_call';
        const preset = (db.cotPresets || []).find(p => p.id === activePresetId);
        
        if (preset && preset.items) {
            cotInstruction = preset.items
                .filter(item => item.enabled)
                .map(item => item.content)
                .join('\n\n');
        }

        if (cotInstruction) {
            // 1. 插入后置指令
            messages.push({
                role: 'system',
                content: cotInstruction
            });

            // 2. 插入触发器
            messages.push({
                role: 'user',
                content: '[incipere]'
            });

            // 3. 插入 Prefill (预填/强塞)
            messages.push({
                role: 'assistant',
                content: '<thinking>'
            });
        }
    }
    // ===============================

    // 3. 发起请求
    const requestBody = {
        model: model,
        messages: messages,
        stream: streamEnabled,
        temperature: 0.7 // 通话稍微低一点，保持稳定
    };

    // 适配 Gemini
    if (provider === 'gemini') {
        const contents = messages.filter(m => m.role !== 'system').map(m => {
            const contentParts = Array.isArray(m.content)
                ? m.content.map(part => {
                    if (part.type === 'text') {
                        return { text: part.text };
                    }
                    if (part.type === 'image_url') {
                        const match = String(part.image_url && part.image_url.url || '').match(/^data:(image\/[^;]+);base64,(.*)$/);
                        if (match) {
                            return {
                                inline_data: {
                                    mime_type: match[1],
                                    data: match[2]
                                }
                            };
                        }
                    }
                    return null;
                }).filter(Boolean)
                : [{ text: m.content }];
            return {
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: contentParts
            };
        });
        requestBody.contents = contents;
        
        // 合并所有 system 消息到 system_instruction
        const allSystemPrompts = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        requestBody.system_instruction = {parts: [{text: allSystemPrompts}]};
        
        delete requestBody.messages;
    }

    const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:streamGenerateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
    const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
    };

    if (visionFrames.length > 0) {
        console.log('[VideoCall] Multimodal Request:', {
            provider,
            model,
            stream: streamEnabled,
            imageCount: visionFrames.length,
            route: options.visionRoute || 'unknown'
        });
    } else {
        console.log('[VideoCall] Request Body:', JSON.stringify(requestBody, null, 2));
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} ${errorText}`);
        }

        if (!streamEnabled) {
            const data = await response.json();
            console.log('[VideoCall] Response Data:', data);
            
            let text = "";
            if (provider === 'gemini') {
                text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            } else {
                if (!data.choices || !data.choices.length || !data.choices[0].message) {
                    console.error("Invalid API Response Structure:", data);
                    throw new Error("API返回数据格式异常，缺少 choices 或 message 字段");
                }
                text = data.choices[0].message.content;
            }

            // === CoT 处理：补全开头，提取思考，净化输出 ===
            if (cotEnabled && text) {
                // 1. 补全开头 (如果被 Prefill 吃掉)
                if (!text.trim().startsWith('<thinking>') && text.includes('</thinking>')) {
                    text = '<thinking>' + text;
                }
                
                // 2. 提取并移除思考内容
                const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/);
                if (thinkingMatch) {
                    const thinkingContent = thinkingMatch[1];
                    console.log('[VideoCall CoT] Thinking:', thinkingContent);
                    // 移除思考标签及内容
                    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/, "").trim();
                }
                
                // 3. 移除 [incipere] (如果有残留)
                text = text.replace(/\[incipere\]/g, "");
            }
            // =============================================

            console.log('[VideoCall] Cleaned AI Response:', text);
            // 一次性回调
            onStreamUpdate(text);
            return text;
        } else {
            console.log('[VideoCall] Stream started (Background Mode)...');
            // 流式处理 (照搬 processStream 逻辑)
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let accumulatedChunk = ""; // 引入累积缓冲区处理跨包数据
            
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                accumulatedChunk += decoder.decode(value, {stream: true});
                
                // OpenAI / DeepSeek / Claude / NewAPI 解析逻辑 (处理跨包)
                if (provider === "openai" || provider === "deepseek" || provider === "claude" || provider === "newapi") {
                    const parts = accumulatedChunk.split("\n\n");
                    accumulatedChunk = parts.pop(); // 保留未完成的部分
                    for (const part of parts) {
                        if (part.startsWith("data: ")) {
                            const data = part.substring(6);
                            if (data.trim() !== "[DONE]") {
                                try {
                                    const text = JSON.parse(data).choices[0].delta?.content || "";
                                    if (text) {
                                        buffer += text;
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                }
            }

            // Gemini 解析逻辑 (在流结束后处理完整 JSON)
            if (provider === "gemini") {
                try {
                    // 尝试解析累积的 chunk (Gemini 流式返回的是完整的 JSON 数组片段？需确认 processStream 逻辑)
                    // processStream 中 Gemini 解析是在循环外的，假设 accumulatedChunk 是完整的 JSON 数组
                    // 但如果 accumulatedChunk 是多个 JSON 对象的拼接（如 OpenAI 格式），JSON.parse 会失败。
                    // 这里假设 processStream 的逻辑是正确的：
                    const parsedStream = JSON.parse(accumulatedChunk);
                    buffer = parsedStream.map(item => item.candidates?.[0]?.content?.parts?.[0]?.text || "").join('');
                } catch (e) {
                    console.error("Error parsing Gemini stream:", e, "Chunk:", accumulatedChunk);
                    // 兜底：如果解析失败，可能是因为 accumulatedChunk 包含了 OpenAI 格式的数据（如果用户选错 provider）
                    // 尝试用 OpenAI 逻辑解析一下？
                    // 暂时不加，保持与 processStream 一致
                }
            }

            console.log('[VideoCall] Final Buffer:', buffer);

            // === CoT 处理：补全开头，提取思考，净化输出 ===
            if (cotEnabled && buffer) {
                // 1. 补全开头 (如果被 Prefill 吃掉)
                if (!buffer.trim().startsWith('<thinking>') && buffer.includes('</thinking>')) {
                    buffer = '<thinking>' + buffer;
                }
                
                // 2. 提取并移除思考内容
                const thinkingMatch = buffer.match(/<thinking>([\s\S]*?)<\/thinking>/);
                if (thinkingMatch) {
                    const thinkingContent = thinkingMatch[1];
                    console.log('[VideoCall CoT] Thinking:', thinkingContent);
                    // 移除思考标签及内容
                    buffer = buffer.replace(/<thinking>[\s\S]*?<\/thinking>/, "").trim();
                }
                
                // 3. 移除 [incipere] (如果有残留)
                buffer = buffer.replace(/\[incipere\]/g, "");
            }

            // 流结束后一次性回调
            onStreamUpdate(buffer);
            return buffer;
        }
    } catch (e) {
        console.error("Call API Error:", e);
        showToast("通话连接不稳定...");
        return null;
    }
}

async function generateCallSummary(chat, callContext) {
    let {url, key, model, provider} = db.apiSettings;
    if (!url || !key || !model) return null;
    if (url.endsWith('/')) url = url.slice(0, -1);

    // 获取世界书
    const worldBooksBefore = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'before')).filter(Boolean).map(wb => wb.content).join('\n');
    const worldBooksAfter = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'after')).filter(Boolean).map(wb => wb.content).join('\n');

    // 获取回忆日记
    const favoritedJournals = (chat.memoryJournals || [])
        .filter(j => j.isFavorited)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');

    let prompt = `请根据以下背景信息和通话记录，生成一份详尽完整的通话记录总结。此总结将作为后续聊天的上下文记忆，角色只能通过此总结了解通话中发生的一切，因此必须尽可能完整，不得遗漏重要细节。\n\n`;

    prompt += `<char_settings>\n`;
    prompt += `角色名：${chat.realName}\n`;
    prompt += `角色设定：${chat.persona || "无"}\n`;
    if (worldBooksBefore) prompt += `${worldBooksBefore}\n`;
    if (worldBooksAfter) prompt += `${worldBooksAfter}\n`;
    prompt += `</char_settings>\n\n`;

    prompt += `<user_settings>\n`;
    prompt += `用户称呼：${chat.myName}\n`;
    prompt += `用户人设：${chat.myPersona || "无"}\n`;
    prompt += `</user_settings>\n\n`;

    if (favoritedJournals) {
        prompt += `<memoir>\n`;
        prompt += `【共同回忆】\n${favoritedJournals}\n`;
        prompt += `</memoir>\n\n`;
    }

    prompt += `通话记录：\n`;
    prompt += `${callContext.map(m => `${m.role === 'ai' ? chat.realName : chat.myName} (${m.type}): ${m.content}`).join('\n')}\n\n`;

    prompt += `要求：\n`;
    prompt += `1. 第三人称叙述。\n`;
    prompt += `2. **完整覆盖，不得省略**：按照通话发展顺序，逐一记录每一个话题、重要对话、事件与行为。通话越长内容越多，总结篇幅也应相应越长，绝对不允许以"简短"为由压缩或跳过任何内容。\n`;
    prompt += `3. **保留关键细节**：双方说过的重要的话、做出的约定或承诺、表达的态度与立场、透露的信息都需要记录在内。\n`;
    prompt += `4. **客观平实**：使用第三人称视角，客观陈述事实。**绝对禁止使用强烈的情绪词汇**（如"极度愤怒"、"痛彻心扉"、"欣喜若狂"等），保持冷静、克制的叙述风格。\n`;
    prompt += `5. **无升华**：不要进行价值升华、感悟或总结性评价，仅记录发生了什么。\n`;
    prompt += `6. 不要包含"通话记录如下"等废话，直接输出总结内容。\n`;

    const messages = [{role: 'user', content: prompt}];
    
    const requestBody = {
        model: model,
        messages: messages,
        stream: false
    };
    
    if (provider === 'gemini') {
         requestBody.contents = [{role: 'user', parts: [{text: prompt}]}];
         delete requestBody.messages;
    }

    const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:generateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
    const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
    };

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        const data = await response.json();
        let text = "";
        if (provider === 'gemini') {
            text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } else {
            text = data.choices[0].message.content;
        }
        return text.trim();
    } catch (e) {
        console.error("Summary API Error:", e);
        return null;
    }
}
