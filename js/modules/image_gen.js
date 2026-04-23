// --- 生图模块 (js/modules/image_gen.js) ---
// 负责：读取生图设置、拼提示词、调用生图 API、解析图片数据返回 dataUrl

const ImageGenModule = (() => {

    // ── 读取全局生图配置 ──
    function getConfig() {
        return (typeof db !== 'undefined' && db.imageGenSettings) ? db.imageGenSettings : {};
    }

    function isEnabled() {
        const cfg = getConfig();
        return !!(cfg.enabled && cfg.url && cfg.key && cfg.model);
    }

    // ── 正则：识别角色「发来的照片/视频」或「发来的照片」，兼容两种写法 ──
    const PHOTO_REGEX = /\[(?:.+?)发来的照片(?:\/视频)?[：:]([\s\S]+?)\]/;

    /**
     * 从消息 content 里抽出「画面描述」，没有则返回 null
     */
    function extractScenePrompt(content) {
        if (!content) return null;
        const m = content.match(PHOTO_REGEX);
        if (!m) return null;
        return m[1].trim();
    }

    /**
     * 拼装最终发给生图 API 的提示词（兼容旧调用）
     */
    function buildPrompt(sceneText, anchor) {
        const parts = [];
        if (anchor && anchor.trim()) parts.push(anchor.trim());
        parts.push(sceneText);
        return parts.join('，');
    }

    /** 角色是否已设有效参考图（data URL） */
    function hasRefImage(char) {
        const s = char && char.imageGenRefDataUrl;
        return typeof s === 'string' && s.startsWith('data:') && s.length > 80;
    }

    /**
     * 按角色设置拼接生图提示：有参考时以图锁脸 + 方括号内为戏/场景；无参考时拼短外貌词 + 场景
     */
    function buildImageGenPrompt(sceneText, char) {
        const scene = (sceneText || '').trim();
        if (!scene) return '';
        if (hasRefImage(char)) {
            return [
                '与参考人物为同一人。以下为本次画面内容；请整图重绘、统一光照与风格，避免贴图换底感。表情、动作、氛围按文字描述，气质克制、少油腻感：',
                scene
            ].join('\n');
        }
        const hint = (char && char.imageGenNoRefHint != null && String(char.imageGenNoRefHint).trim())
            ? String(char.imageGenNoRefHint).trim()
            : (char && char.imageAppearanceAnchor) ? String(char.imageAppearanceAnchor).trim() : '';
        if (hint) return [hint, scene].join('，');
        return scene;
    }

    /** Gemini 多模态：参考图 data URL + 文本提示 */
    async function generateWithReferenceDataUrl(dataUrl, textPrompt, signal) {
        const cfg = getConfig();
        let { url, key, model } = cfg;
        if (!url || !key || !model || !dataUrl || !textPrompt) throw new Error('生图配置不完整');
        if (url.endsWith('/')) url = url.slice(0, -1);
        if (!_isGeminiConfig(cfg)) {
            throw new Error('参考图生图需使用 Gemini 类接口（generateContent 多模态）');
        }
        const { mimeType, data } = _parseDataUrlParts(dataUrl);
        const keyParam = (typeof getRandomValue === 'function') ? getRandomValue(key) : key;
        const endpoint = `${url}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(keyParam)}`;
        const body = {
            contents: [{
                parts: [
                    { inlineData: { mimeType, data } },
                    { text: textPrompt }
                ]
            }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
        };
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
        });
        const rawText = await resp.text();
        let json;
        try {
            json = JSON.parse(rawText);
        } catch {
            throw new Error(`接口返回非 JSON（${resp.status}）：${rawText.slice(0, 240)}`);
        }
        if (!resp.ok) {
            const msg = json.error?.message || json.message || rawText.slice(0, 300);
            throw new Error(`HTTP ${resp.status}：${msg}`);
        }
        const out = _imageDataUrlFromGeminiResponse(json);
        if (!out) {
            const maybeText = json.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
            throw new Error(
                '响应中未找到生成图（inlineData）。' +
                (maybeText ? `模型返回文字：${maybeText.slice(0, 120)}…` : '')
            );
        }
        return out;
    }

    /**
     * 根据角色设置选择纯文生图或多模态垫图
     */
    async function generateImageForCharacter(char, sceneText, signal) {
        const prompt = buildImageGenPrompt(sceneText, char);
        if (hasRefImage(char)) {
            const cfg = getConfig();
            if (_isGeminiConfig(cfg)) {
                return await generateWithReferenceDataUrl(char.imageGenRefDataUrl, prompt, signal);
            }
            return await generateImage(prompt, signal);
        }
        return await generateImage(prompt, signal);
    }

    /**
     * 调用生图 API，返回 dataUrl（base64 格式）
     * 支持两种响应格式：
     *   - OpenAI images/generations 风格：data[0].b64_json 或 data[0].url
     *   - Gemini generateContent 风格：candidates[0].content.parts[0].inlineData.data
     */
    async function generateImage(prompt, signal) {
        const cfg = getConfig();
        let { url, key, model } = cfg;
        if (!url || !key || !model || !prompt) throw new Error('生图配置不完整');
        if (url.endsWith('/')) url = url.slice(0, -1);

        // 判断是 gemini 还是 openai 兼容
        const isGemini = cfg.provider === 'gemini' ||
            model.toLowerCase().includes('gemini') ||
            url.includes('generativelanguage.googleapis.com');

        let responseData;

        if (isGemini) {
            // Gemini generateContent 接口
            const endpoint = `${url}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`;
            const body = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
            };
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`生图 API 错误 ${resp.status}：${errText.slice(0, 200)}`);
            }
            responseData = await resp.json();

            // 遍历 parts 找 inlineData（图片）
            const parts = responseData?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
                if (p.inlineData && p.inlineData.data) {
                    const mime = p.inlineData.mimeType || 'image/jpeg';
                    return `data:${mime};base64,${p.inlineData.data}`;
                }
            }
            throw new Error('生图 API 返回中未找到图片数据（inlineData）');

        } else {
            // OpenAI 兼容 /v1/images/generations
            const endpoint = `${url}/v1/images/generations`;
            const body = {
                model,
                prompt,
                n: 1,
                size: cfg.size || '1024x1024',
                response_format: 'b64_json'
            };
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${key}`
                },
                body: JSON.stringify(body),
                signal
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`生图 API 错误 ${resp.status}：${errText.slice(0, 200)}`);
            }
            responseData = await resp.json();

            const item = responseData?.data?.[0];
            if (!item) throw new Error('生图 API 返回中未找到图片数据');

            if (item.b64_json) {
                return `data:image/png;base64,${item.b64_json}`;
            } else if (item.url) {
                // 若 API 只返回 URL（部分聚合站），先 fetch 转 dataUrl
                const imgResp = await fetch(item.url, { signal });
                if (!imgResp.ok) throw new Error('图片 URL 下载失败');
                const blob = await imgResp.blob();
                return await _blobToDataUrl(blob);
            }
            throw new Error('生图 API 返回格式未知，无法提取图片');
        }
    }

    function _blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /** data URL -> { mimeType, data } 纯 base64 */
    function _parseDataUrlParts(dataUrl) {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
        if (!m) throw new Error('图片不是有效的 data URL');
        return { mimeType: m[1], data: m[2].replace(/\s/g, '') };
    }

    /** 与 generateImage 相同：从 Gemini generateContent 响应里拆出第一张图 */
    function _imageDataUrlFromGeminiResponse(responseData) {
        const parts = responseData?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
            if (p.inlineData && p.inlineData.data) {
                const mime = p.inlineData.mimeType || 'image/jpeg';
                return `data:${mime};base64,${p.inlineData.data}`;
            }
        }
        return null;
    }

    function _isGeminiConfig(cfg) {
        const m = (cfg.model || '').toLowerCase();
        const u = (cfg.url || '');
        return cfg.provider === 'gemini' || m.includes('gemini') || u.includes('generativelanguage.googleapis.com');
    }

    /**
     * 测试「参考图 + 文字」是否被当前 gemai 模型接受（垫图 / 图生图前置探测）
     * 仅走 Gemini generateContent；与纯文生使用同一 endpoint，仅 parts 多一张 inlineData。
     */
    async function testReferenceImageWithFile(file) {
        if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件');
        saveFromUI();
        const cfg = getConfig();
        if (!cfg.url || !cfg.key || !cfg.model) throw new Error('请先填写接口地址、密钥与模型');

        if (!_isGeminiConfig(cfg)) {
            throw new Error('垫图测试需使用「接口类型：Gemini」或模型名含 gemini（与 :generateContent 一致）。OpenAI 的 /v1/images/generations 不支持传参考图。');
        }

        let dataUrl;
        if (typeof compressImage === 'function') {
            dataUrl = await compressImage(file, { maxWidth: 1024, maxHeight: 1024, quality: 0.88 });
        } else {
            dataUrl = await _blobToDataUrl(file);
        }
        const textHint =
            '与参考人物为同一人，保持五官与发型整体特征一致。请生成全新画面（不要沿用参考图姿势与角度）：他坐在现代办公室落地窗前，侧脸朝向镜头一侧，表情略带玩味，眼神落在玻璃反光上；仅半身，黑衬衫解开一粒扣。室内城市夜景与台灯光，光从一侧打在颧骨，与窗外冷光形成对比。整图同一场景、环境光落在脸与背景上一致，自然融合，不要贴图换底感。写实、3D乙游成男风格。仅输出图像。';

        return generateWithReferenceDataUrl(dataUrl, textHint, null);
    }

    // ── 设置页 UI 相关 ──

    function loadToUI() {
        const cfg = getConfig();
        _setVal('ig-global-switch', cfg.enabled ?? false, 'checked');
        _setVal('ig-api-url',    cfg.url   || '');
        _setVal('ig-api-key',    cfg.key   || '');
        _setVal('ig-api-provider', cfg.provider || 'openai');
        _setVal('ig-image-size', cfg.size  || '1024x1024');

        const modelSel = document.getElementById('ig-api-model');
        const savedModel = (cfg.model || '').trim();
        if (modelSel && modelSel.tagName === 'SELECT') {
            modelSel.innerHTML = '';
            if (savedModel) {
                const opt = document.createElement('option');
                opt.value = savedModel;
                opt.textContent = savedModel;
                modelSel.appendChild(opt);
                modelSel.value = savedModel;
            } else {
                const ph = document.createElement('option');
                ph.value = '';
                ph.textContent = '请先拉取';
                modelSel.appendChild(ph);
            }
        } else {
            _setVal('ig-api-model', savedModel);
        }
    }

    /**
     * 拉取远端模型列表填入 #ig-api-model（与主 API「拉取」逻辑一致）
     */
    async function fetchAndPopulateImageModels(showToastFlag = true) {
        let apiUrl = (_getVal('ig-api-url') || '').trim();
        const apiKey = (_getVal('ig-api-key') || '').trim();
        const provider = _getVal('ig-api-provider') || 'openai';
        const modelSelect = document.getElementById('ig-api-model');
        const fetchBtn = document.getElementById('ig-fetch-models-btn');

        if (!apiUrl || !apiKey) {
            if (showToastFlag && typeof showToast === 'function') {
                showToast('请先填写生图接口地址和密钥！');
            }
            return;
        }
        if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);

        const keyParam = (typeof getRandomValue === 'function') ? getRandomValue(apiKey) : apiKey;
        const endpoint = provider === 'gemini'
            ? `${apiUrl}/v1beta/models?key=${keyParam}`
            : `${apiUrl}/v1/models`;
        const headers = provider === 'gemini' ? {} : { Authorization: `Bearer ${apiKey}` };

        if (fetchBtn) {
            fetchBtn.classList.add('loading');
            fetchBtn.disabled = true;
        }

        try {
            const response = await fetch(endpoint, { method: 'GET', headers });
            if (!response.ok) {
                const t = await response.text();
                throw new Error(`HTTP ${response.status}：${(t || '').slice(0, 120)}`);
            }
            const data = await response.json();
            let models = [];
            if (provider !== 'gemini' && data.data) {
                models = data.data.map(e => e.id);
            } else if (provider === 'gemini' && data.models) {
                models = data.models.map(e => (e.name || '').replace(/^models\//, ''));
            }

            const imageish = (id) => /image|imagen|dall|gpt-image|flux|banana|绘|生图|nanobanana/i.test(id);
            const sorted = [...models].sort((a, b) => {
                const da = imageish(a) ? 0 : 1;
                const db = imageish(b) ? 0 : 1;
                if (da !== db) return da - db;
                return String(a).localeCompare(String(b));
            });

            const currentVal = modelSelect ? modelSelect.value : '';
            const fromDb = (typeof db !== 'undefined' && db.imageGenSettings) ? (db.imageGenSettings.model || '').trim() : '';

            if (modelSelect) {
                modelSelect.innerHTML = '';
                if (sorted.length > 0) {
                    sorted.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m;
                        opt.textContent = m;
                        modelSelect.appendChild(opt);
                    });
                    if (sorted.includes(currentVal)) {
                        modelSelect.value = currentVal;
                    } else if (fromDb && sorted.includes(fromDb)) {
                        modelSelect.value = fromDb;
                    }
                } else {
                    const ph = document.createElement('option');
                    ph.value = '';
                    ph.textContent = '未找到任何模型';
                    modelSelect.appendChild(ph);
                }
            }

            if (showToastFlag && typeof showToast === 'function') {
                showToast(sorted.length > 0 ? '生图模型列表拉取成功！' : '未找到任何模型');
            }
        } catch (err) {
            console.error('[ImageGen] fetch models', err);
            if (showToastFlag) {
                if (typeof showApiError === 'function') showApiError(err);
                else if (typeof showToast === 'function') showToast('拉取失败：' + (err.message || err));
            }
        } finally {
            if (fetchBtn) {
                fetchBtn.classList.remove('loading');
                fetchBtn.disabled = false;
            }
        }
    }

    function saveFromUI() {
        if (typeof db === 'undefined') return;
        db.imageGenSettings = {
            enabled:  !!_getVal('ig-global-switch', 'checked'),
            url:      (_getVal('ig-api-url')      || '').trim(),
            key:      (_getVal('ig-api-key')      || '').trim(),
            model:    (_getVal('ig-api-model')    || '').trim(),
            provider: _getVal('ig-api-provider')  || 'openai',
            size:     _getVal('ig-image-size')    || '1024x1024',
        };
    }

    /** 将角色生图相关字段填入聊天设置「生图」Tab */
    function loadCharImageGenToUI(chat) {
        if (!chat) return;
        const hint = (chat.imageGenNoRefHint != null && String(chat.imageGenNoRefHint).trim())
            ? chat.imageGenNoRefHint
            : (chat.imageAppearanceAnchor || '');
        _setVal('setting-ig-no-ref-hint', hint);
        const prev = document.getElementById('setting-ig-ref-preview');
        const ref = chat.imageGenRefDataUrl;
        if (prev) {
            if (ref && String(ref).startsWith('data:')) {
                prev.src = ref;
                prev.style.display = 'block';
            } else {
                prev.removeAttribute('src');
                prev.style.display = 'none';
            }
        }
    }

    function saveCharImageGenFromUI(chat) {
        if (!chat) return;
        chat.imageGenNoRefHint = String(_getVal('setting-ig-no-ref-hint') || '').trim();
        const prev = document.getElementById('setting-ig-ref-preview');
        if (prev && prev.src && prev.src.startsWith('data:')) {
            chat.imageGenRefDataUrl = prev.src;
        } else {
            chat.imageGenRefDataUrl = '';
        }
    }

    /** 兼容旧代码：长框已废弃，读写到新字段时顺带保留旧键供迁移期读取 */
    function loadCharAnchorToUI(chat) { loadCharImageGenToUI(chat); }
    function saveCharAnchorFromUI(chat) { saveCharImageGenFromUI(chat); }

    let _charImageGenTabBound = false;
    function initCharImageGenTab() {
        if (_charImageGenTabBound) return;
        const file = document.getElementById('setting-ig-ref-file');
        const choose = document.getElementById('setting-ig-ref-choose');
        const clearBtn = document.getElementById('setting-ig-ref-clear');
        const prev = document.getElementById('setting-ig-ref-preview');
        if (!file || !choose) return;
        _charImageGenTabBound = true;
        choose.addEventListener('click', () => {
            file.value = '';
            file.click();
        });
        file.addEventListener('change', async (ev) => {
            const f = ev.target.files && ev.target.files[0];
            if (!f || !f.type.startsWith('image/')) return;
            try {
                const dataUrl = (typeof compressImage === 'function')
                    ? await compressImage(f, { maxWidth: 1024, maxHeight: 1024, quality: 0.88 })
                    : await _blobToDataUrl(f);
                if (prev) {
                    prev.src = dataUrl;
                    prev.style.display = 'block';
                }
            } catch (err) {
                console.error('[ImageGen] ref file', err);
                if (typeof showToast === 'function') showToast('图片处理失败，请重试');
            }
        });
        if (clearBtn && prev) {
            clearBtn.addEventListener('click', () => {
                file.value = '';
                prev.removeAttribute('src');
                prev.style.display = 'none';
            });
        }
    }

    function initApiSection() {
        loadToUI();
        const saveBtn = document.getElementById('ig-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                saveFromUI();
                if (typeof saveData === 'function') saveData();
                if (typeof showToast === 'function') showToast('生图设置已保存！');
            });
        }
        const testBtn = document.getElementById('ig-test-btn');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                if (!isEnabled()) {
                    showToast('请先填写并保存生图配置');
                    return;
                }
                testBtn.disabled = true;
                testBtn.textContent = '生成中…';
                try {
                    const dataUrl = await generateImage('a beautiful sunset over the ocean, photo style');
                    if (typeof openImageViewer === 'function') openImageViewer(dataUrl);
                    showToast('生图测试成功！');
                } catch (e) {
                    showToast('生图测试失败：' + e.message);
                } finally {
                    testBtn.disabled = false;
                    testBtn.textContent = '测试生图';
                }
            });
        }
        const fetchBtn = document.getElementById('ig-fetch-models-btn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', () => fetchAndPopulateImageModels(true));
        }

        const refFile = document.getElementById('ig-test-ref-file');
        const refBtn  = document.getElementById('ig-test-ref-btn');
        if (refBtn && refFile) {
            refBtn.addEventListener('click', () => {
                const u = (_getVal('ig-api-url') || '').trim();
                const k = (_getVal('ig-api-key') || '').trim();
                const m = (_getVal('ig-api-model') || '').trim();
                if (!u || !k || !m) {
                    if (typeof showToast === 'function') showToast('请先填写接口地址、密钥与模型，并保存');
                    return;
                }
                refFile.value = '';
                refFile.click();
            });
            refFile.addEventListener('change', async (ev) => {
                const f = ev.target.files && ev.target.files[0];
                if (!f) return;
                refBtn.disabled = true;
                const oldText = refBtn.textContent;
                refBtn.textContent = '垫图测试中…';
                try {
                    const dataUrl = await testReferenceImageWithFile(f);
                    if (typeof openImageViewer === 'function') openImageViewer(dataUrl);
                    if (typeof showToast === 'function') {
                        showToast('垫图测试成功：接口已接受参考图并返回新图');
                    }
                } catch (e) {
                    console.error('[ImageGen] testReferenceImage', e);
                    if (typeof showToast === 'function') showToast('垫图测试失败：' + (e.message || e));
                } finally {
                    refBtn.disabled = false;
                    refBtn.textContent = oldText || '测试参考图（垫图）';
                }
            });
        }
    }

    function _setVal(id, val, prop = 'value') {
        const el = document.getElementById(id);
        if (!el) return;
        if (prop === 'checked') el.checked = !!val;
        else el[prop] = val;
    }
    function _getVal(id, prop = 'value') {
        const el = document.getElementById(id);
        if (!el) return '';
        if (prop === 'checked') return el.checked;
        return el[prop];
    }

    return {
        isEnabled,
        extractScenePrompt,
        buildPrompt,
        buildImageGenPrompt,
        hasRefImage,
        generateImage,
        generateWithReferenceDataUrl,
        generateImageForCharacter,
        loadToUI,
        saveFromUI,
        loadCharImageGenToUI,
        saveCharImageGenFromUI,
        loadCharAnchorToUI,
        saveCharAnchorFromUI,
        initCharImageGenTab,
        initApiSection,
        fetchAndPopulateImageModels,
        testReferenceImageWithFile,
        PHOTO_REGEX,
    };
})();

window.ImageGenModule = ImageGenModule;
window.fetchImageGenModels = (flag) => ImageGenModule.fetchAndPopulateImageModels(flag);
