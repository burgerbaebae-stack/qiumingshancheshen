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

    // ── 正则：识别「发来的照片」及可选标签；仍兼容旧存档里的「发来的照片/视频」「发来的视频」 ──
    // 可选 ·锁脸 | ·空镜 | ·局部：控制是否使用参考图垫脸（无标签时与历史一致，视为锁脸）
    const PHOTO_REGEX = /\[(?:.+?)发来的(?:照片\/视频|照片|视频)(?:·(锁脸|空镜|局部))?[：:]([\s\S]+?)\]/;
    /** 文生/垫图文字提示过长时截断，减轻网关/上游异常 */
    const MAX_IG_TEXT_PROMPT_LEN = 16000;

    /** @typedef {'lock'|'scene'|'partial'} ImageGenRefMode */

    /**
     * 解析「发来的照片」方括号块：画面正文 + 生图参考模式（无标签 → lock）
     * @returns {{ sceneText: string, refMode: ImageGenRefMode, rawTag: string|null }|null}
     */
    function parsePhotoBlock(content) {
        if (!content) return null;
        const m = content.match(PHOTO_REGEX);
        if (!m) return null;
        const sceneText = (m[2] || '').trim();
        if (!sceneText) return null;
        const rawTag = m[1] || null;
        /** @type {ImageGenRefMode} */
        const refMode = !rawTag ? 'lock' : { 锁脸: 'lock', 空镜: 'scene', 局部: 'partial' }[rawTag];
        return { sceneText, refMode, rawTag };
    }

    /**
     * 从消息 content 里抽出「画面描述」，没有则返回 null
     */
    function extractScenePrompt(content) {
        const p = parsePhotoBlock(content);
        return p ? p.sceneText : null;
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

    function _isValidDataUrlRef(s) {
        return typeof s === 'string' && s.startsWith('data:') && s.length > 80;
    }

    /** 槽① 锁脸参考 */
    function hasRefImage(char) {
        return _isValidDataUrlRef(char && char.imageGenRefDataUrl);
    }

    /** 槽② 空镜画风 */
    function hasStyleRefImage(char) {
        return _isValidDataUrlRef(char && char.imageGenStyleRefDataUrl);
    }

    /** 槽③ 局部肢体 */
    function hasBodyRefImage(char) {
        return _isValidDataUrlRef(char && char.imageGenBodyRefDataUrl);
    }

    /**
     * 本轮实际用于多模态的参考图（每次仅一张）
     * @returns {{ url: string, kind: 'face'|'style'|'body' }|null}
     */
    function pickCharacterRefForMode(char, refMode) {
        const mode = refMode || 'lock';
        if (mode === 'lock' && hasRefImage(char)) {
            return { url: char.imageGenRefDataUrl, kind: 'face' };
        }
        if (mode === 'scene' && hasStyleRefImage(char)) {
            return { url: char.imageGenStyleRefDataUrl, kind: 'style' };
        }
        if (mode === 'partial') {
            if (hasBodyRefImage(char)) {
                return { url: char.imageGenBodyRefDataUrl, kind: 'body' };
            }
            if (hasStyleRefImage(char)) {
                return { url: char.imageGenStyleRefDataUrl, kind: 'style' };
            }
        }
        return null;
    }

    /**
     * @param {string} sceneText
     * @param {*} char
     * @param {ImageGenRefMode} [refMode='lock']
     */
    function buildImageGenPrompt(sceneText, char, refMode = 'lock') {
        const scene = (sceneText || '').trim();
        if (!scene) return '';
        const mode = refMode || 'lock';
        const sceneSuffix = mode === 'scene'
            ? '\n\n【生图约束】本画面为无真人或全身人像的场景/物体；勿因参考角色设定而在画面中加入未在描述中出现的真人。仅按上文描述生成。'
            : mode === 'partial'
                ? '\n\n【生图约束】严格按上文取景；若仅描述身体局部（如手、指、腕等），画面中不得出现面部或完整人像，勿补全全身或正脸。'
                : '';
        const sceneWithSuffix = scene + sceneSuffix;

        const picked = pickCharacterRefForMode(char, mode);
        if (picked) {
            if (picked.kind === 'face') {
                return [
                    '与参考人物为同一人（五官与整体气质对齐参考）。以下为本次画面内容；请整图重绘、统一光照与风格，避免贴图换底感。**服饰、发型、帽饰、耳环等配饰、面部敷贴/创口贴、具体衣着款式与颜色、表情与神态**均以正文为准；正文未写明的项**勿默认沿用**参考图中的穿搭、装饰品或神态姿势。若正文对神态、动作有描述则严格依正文，勿照搬参考图里的表情与气场。气质克制、少油腻感：',
                    sceneWithSuffix
                ].join('\n');
            }
            if (picked.kind === 'style') {
                return [
                    '【参考图说明】附图仅作渲染风格、光影与材质气质参考（如高精度 3D 游戏 CG），不是本帧要绘制的主体。请严格按下列文字生成画面，勿照搬参考图中的具体物体、人物或构图；若附图含人物，本生成图中不得出现该人物。若正文出现人物，其**装扮与神态**须完全依正文，勿复用参考图中人物的表情、衣着与配饰。正文以文字为准：',
                    sceneWithSuffix
                ].join('\n');
            }
            if (picked.kind === 'body') {
                return [
                    '【参考图说明】附图用于同一角色**肢体、手型、肤色与肌肉**的渲染风格与体块参考（3D CG 质感），**不是**服装与神态模板。**服饰、发型、帽饰、敷贴/饰品、表情与神态、具体姿势气场**均以正文为准，勿照搬参考图；正文未写的配饰与神态勿自行从参考图抄入。取景、场景与镜头以文字为准；若参考图含面部而文字未要求出现脸，则不得生成完整正对镜头的人脸：',
                    sceneWithSuffix
                ].join('\n');
            }
        }
        const hint = (char && char.imageGenNoRefHint != null && String(char.imageGenNoRefHint).trim())
            ? String(char.imageGenNoRefHint).trim()
            : (char && char.imageAppearanceAnchor) ? String(char.imageAppearanceAnchor).trim() : '';
        if (hint) return [hint, sceneWithSuffix].join('，');
        return sceneWithSuffix;
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
        let text = textPrompt;
        if (text.length > MAX_IG_TEXT_PROMPT_LEN) {
            console.warn(`[ImageGen] 垫图提示词过长，已截断至 ${MAX_IG_TEXT_PROMPT_LEN} 字符`);
            text = text.slice(0, MAX_IG_TEXT_PROMPT_LEN) + '…';
        }
        const body = {
            contents: [{
                parts: [
                    { inlineData: { mimeType, data } },
                    { text }
                ]
            }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
        };
        const post = () => fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
        });
        let resp = await post();
        if (!resp.ok && [500, 502, 503, 504].includes(resp.status)) {
            await new Promise((r) => setTimeout(r, 900));
            resp = await post();
        }
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
    /**
     * @param {*} char
     * @param {string} sceneText
     * @param {AbortSignal|null} signal
     * @param {ImageGenRefMode} [refMode='lock'] 按模式选用槽①/②/③ 之一作为多模态参考（每次一张）
     */
    async function generateImageForCharacter(char, sceneText, signal, refMode = 'lock') {
        const mode = refMode || 'lock';
        const prompt = buildImageGenPrompt(sceneText, char, mode);
        const picked = pickCharacterRefForMode(char, mode);
        if (picked) {
            const cfg = getConfig();
            if (_isGeminiConfig(cfg)) {
                return await generateWithReferenceDataUrl(picked.url, prompt, signal);
            }
            if (_supportsOpenAIReferenceEdit(cfg)) {
                return await generateOpenAIWithReferenceDataUrl(picked.url, prompt, signal);
            }
            console.warn('[ImageGen] 已设置本模式参考图，但当前模型非 Gemini 且非 gpt-image / dall-e-2 等可垫图模型，将仅使用文字生图。');
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

        if (prompt.length > MAX_IG_TEXT_PROMPT_LEN) {
            console.warn(`[ImageGen] 文生图提示词过长，已截断至 ${MAX_IG_TEXT_PROMPT_LEN} 字符`);
            prompt = prompt.slice(0, MAX_IG_TEXT_PROMPT_LEN) + '…';
        }

        // 判断是 gemini 还是 openai 兼容
        const isGemini = cfg.provider === 'gemini' ||
            model.toLowerCase().includes('gemini') ||
            url.includes('generativelanguage.googleapis.com');

        let responseData;

        if (isGemini) {
            // 与 generateWithReferenceDataUrl 一致：多 key 轮询、URL 编码，避免 + & 等破坏 query 或误传密钥
            const keyParam = (typeof getRandomValue === 'function') ? getRandomValue(String(key)) : String(key);
            const endpoint = `${url}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(keyParam)}`;
            const body = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
            };
            const post = () => fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal
            });
            let resp = await post();
            if (!resp.ok && [500, 502, 503, 504].includes(resp.status)) {
                await new Promise((r) => setTimeout(r, 900));
                resp = await post();
            }
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`生图 API 错误 ${resp.status}：${errText.slice(0, 500)}`);
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
            const authKey = (typeof getRandomValue === 'function') ? getRandomValue(String(key)) : String(key);
            const endpoint = `${url}/v1/images/generations`;
            const body = {
                model,
                prompt,
                n: 1,
                size: cfg.size || '1024x1024',
                response_format: 'b64_json'
            };
            const post = () => fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authKey}`
                },
                body: JSON.stringify(body),
                signal
            });
            let resp = await post();
            if (!resp.ok && [500, 502, 503, 504].includes(resp.status)) {
                await new Promise((r) => setTimeout(r, 900));
                resp = await post();
            }
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`生图 API 错误 ${resp.status}：${errText.slice(0, 500)}`);
            }
            responseData = await resp.json();
            return await _dataUrlFromOpenAIGenJson(responseData, signal);
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
     * OpenAI 兼容：是否可用 /v1/images/edits 做「参考图 + 文」（gpt-image-2 / gpt-image-1 等；dall-e-2 为传统编辑接口）
     */
    function _supportsOpenAIReferenceEdit(cfg) {
        if (!cfg || _isGeminiConfig(cfg)) return false;
        const m = (cfg.model || '').toLowerCase();
        if (m.includes('gpt-image')) return true;
        if (m === 'dall-e-2' || m.startsWith('dall-e-2@')) return true;
        return false;
    }

    /** gpt-image 系列尺寸与下拉框里 DALL·E3 风格尺寸对齐（上游仅支持 1024 档） */
    function _mapSizeForOpenAIImageEdit(size) {
        const s = size || '1024x1024';
        if (/^(1024x1024|1024x1536|1536x1024)$/.test(s)) return s;
        if (s === '1024x1792') return '1024x1536';
        if (s === '1792x1024') return '1536x1024';
        if (s === '512x512') return '1024x1024';
        return '1024x1024';
    }

    /**
     * 从 OpenAI /v1/images/generations 或 /v1/images/edits 的 JSON 得到 dataUrl
     */
    async function _dataUrlFromOpenAIGenJson(responseData, signal) {
        const item = responseData?.data?.[0];
        if (!item) throw new Error('生图 API 返回中未找到图片数据');
        if (item.b64_json) {
            return `data:image/png;base64,${item.b64_json}`;
        }
        if (item.url) {
            const imgResp = await fetch(item.url, { signal });
            if (!imgResp.ok) throw new Error('图片 URL 下载失败');
            const blob = await imgResp.blob();
            return await _blobToDataUrl(blob);
        }
        throw new Error('生图 API 返回格式未知，无法提取图片');
    }

    /**
     * OpenAI 兼容垫图：POST /v1/images/edits（multipart），与官方 gpt-image、聚合站透传方式一致
     */
    async function generateOpenAIWithReferenceDataUrl(dataUrl, textPrompt, signal) {
        const cfg = getConfig();
        let { url, key, model } = cfg;
        if (!url || !key || !model || !dataUrl || !textPrompt) throw new Error('生图配置不完整');
        if (!_supportsOpenAIReferenceEdit(cfg)) {
            throw new Error('当前模型不支持 OpenAI 垫图，请使用 gpt-image 系列或 dall-e-2，或改用 Gemini 多模态');
        }
        if (url.endsWith('/')) url = url.slice(0, -1);

        let text = textPrompt;
        if (text.length > MAX_IG_TEXT_PROMPT_LEN) {
            console.warn(`[ImageGen] 垫图提示词过长，已截断至 ${MAX_IG_TEXT_PROMPT_LEN} 字符`);
            text = text.slice(0, MAX_IG_TEXT_PROMPT_LEN) + '…';
        }

        const authKey = (typeof getRandomValue === 'function') ? getRandomValue(String(key)) : String(key);
        const endpoint = `${url}/v1/images/edits`;
        const size = _mapSizeForOpenAIImageEdit(cfg.size);

        const r = await fetch(dataUrl);
        const blob = await r.blob();
        const mime = (String(dataUrl).match(/^data:([^;]+);/) || [null, 'image/png'])[1].split(';')[0];
        const ext = /jpe?g/i.test(mime) ? 'jpg' : (/webp/i.test(mime) ? 'webp' : 'png');
        const fileName = `ref.${ext}`;

        const form = new FormData();
        form.append('model', model);
        form.append('prompt', text);
        form.append('n', '1');
        form.append('size', size);
        form.append('response_format', 'b64_json');
        form.append('image', blob, fileName);

        const post = () => fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${authKey}` },
            body: form,
            signal
        });
        let resp = await post();
        if (!resp.ok && [500, 502, 503, 504].includes(resp.status)) {
            await new Promise((r) => setTimeout(r, 900));
            resp = await post();
        }
        if (!resp.ok) {
            const errText = await resp.text();
            let msg = errText.slice(0, 500);
            try {
                const e = JSON.parse(errText);
                msg = e.error?.message || e.message || msg;
            } catch { /* 保持原文 */ }
            throw new Error(`生图 API 错误 ${resp.status}：${msg}`);
        }
        const responseData = await resp.json();
        return await _dataUrlFromOpenAIGenJson(responseData, signal);
    }

    const DEFAULT_IG_TEST_REF_PROMPT =
        '与参考人物为同一人，保持五官与发型整体特征一致。请生成全新画面（不要沿用参考图姿势与角度）：他坐在现代办公室落地窗前，侧脸朝向镜头一侧，表情略带玩味，眼神落在玻璃反光上；仅半身，黑衬衫解开一粒扣。室内城市夜景与台灯光，光从一侧打在颧骨，与窗外冷光形成对比。整图同一场景、环境光落在脸与背景上一致，自然融合，不要贴图换底感。写实、3D乙游成男风格。仅输出图像。';

    /**
     * 测试「参考图 + 文字」：Gemini 走 generateContent 多模态；OpenAI 兼容且为 gpt-image / dall-e-2 等走 /v1/images/edits
     * @param {File} file 参考图文件
     * @param {string} [textOverride] 若填写则作为文字说明；空则用内置说明（设置页大文本框会传入用户粘贴的提示词）
     */
    async function testReferenceImageWithFile(file, textOverride) {
        if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件');
        saveFromUI();
        const cfg = getConfig();
        if (!cfg.url || !cfg.key || !cfg.model) throw new Error('请先填写接口地址、密钥与模型');

        let dataUrl;
        if (typeof compressImage === 'function') {
            dataUrl = await compressImage(file, { maxWidth: 1024, maxHeight: 1024, quality: 0.88 });
        } else {
            dataUrl = await _blobToDataUrl(file);
        }
        const textHint = (typeof textOverride === 'string' && textOverride.trim().length)
            ? textOverride.trim()
            : DEFAULT_IG_TEST_REF_PROMPT;

        if (_isGeminiConfig(cfg)) {
            return generateWithReferenceDataUrl(dataUrl, textHint, null);
        }
        if (_supportsOpenAIReferenceEdit(cfg)) {
            return generateOpenAIWithReferenceDataUrl(dataUrl, textHint, null);
        }
        throw new Error(
            '垫图测试需使用：「接口类型：Gemini」+ 多模态模型，或「OpenAI 兼容」+ 支持 /v1/images/edits 的模型（如 gpt-image-2、dall-e-2）。' +
            ' 纯文生 /v1/images/generations 无法上传参考图。'
        );
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
        populateIgPresetSelect();
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

    function _getIgPresets() {
        if (typeof db === 'undefined' || !Array.isArray(db.imageGenPresets)) return [];
        return db.imageGenPresets;
    }

    function _setIgPresets(arr) {
        if (typeof db === 'undefined') return;
        db.imageGenPresets = Array.isArray(arr) ? arr : [];
        if (typeof saveData === 'function') saveData();
    }

    function populateIgPresetSelect() {
        const sel = document.getElementById('ig-preset-select');
        if (!sel) return;
        sel.innerHTML = '<option value="">— 选择生图预设 —</option>';
        _getIgPresets().forEach((p) => {
            if (!p || !p.name) return;
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            sel.appendChild(opt);
        });
    }

    function saveIgPreset() {
        const name = prompt('请输入预设名称：');
        if (!name || !name.trim()) return;
        saveFromUI();
        const cfg = { ...getConfig() };
        const trimmed = name.trim();
        const presets = _getIgPresets().slice();
        const idx = presets.findIndex((p) => p.name === trimmed);
        const entry = { name: trimmed, data: cfg };
        if (idx >= 0) presets[idx] = entry;
        else presets.push(entry);
        _setIgPresets(presets);
        populateIgPresetSelect();
        const sel = document.getElementById('ig-preset-select');
        if (sel) sel.value = trimmed;
        if (typeof showToast === 'function') showToast('生图预设已保存！');
    }

    function applyIgPreset() {
        const sel = document.getElementById('ig-preset-select');
        if (!sel || !sel.value) {
            if (typeof showToast === 'function') showToast('请先选择一个预设');
            return;
        }
        const entry = _getIgPresets().find((p) => p.name === sel.value);
        if (!entry || !entry.data) return;
        if (typeof db === 'undefined') return;
        db.imageGenSettings = { ...(getConfig() || {}), ...entry.data };
        if (typeof saveData === 'function') saveData();
        loadToUI();
        if (typeof showToast === 'function') showToast('生图预设已应用！');
    }

    function openIgManageModal() {
        const modal = document.getElementById('ig-presets-modal');
        const list = document.getElementById('ig-preset-list');
        if (!modal || !list) return;

        list.innerHTML = '';
        const presets = _getIgPresets();
        if (!presets.length) {
            list.innerHTML = '<p class="api-preset-manage-empty">暂无已保存的生图预设。</p>';
        } else {
            presets.forEach((p, idx) => {
                const row = document.createElement('div');
                row.className = 'api-preset-manage-row';
                row.innerHTML = `
                    <div class="api-preset-manage-info">
                        <div class="api-preset-manage-name">${p.name}</div>
                    </div>
                    <div class="api-preset-manage-btns">
                        <button type="button" class="btn btn-small api-preset-manage-btn" aria-label="重命名">重命名</button>
                        <button type="button" class="btn btn-small api-preset-manage-btn api-preset-manage-btn--del" aria-label="删除预设">删除</button>
                    </div>
                `;
                const renameBtn = row.querySelector('.api-preset-manage-btn:not(.api-preset-manage-btn--del)');
                renameBtn.addEventListener('click', () => {
                    const newName = prompt('输入新名称：', p.name);
                    if (newName == null) return;
                    const trimmed = newName.trim();
                    if (!trimmed) return;
                    if (trimmed === p.name) return;
                    const all = _getIgPresets();
                    if (all.some((x, i) => i !== idx && x.name === trimmed)) {
                        if (typeof showToast === 'function') showToast('已存在同名预设');
                        return;
                    }
                    all[idx] = { ...all[idx], name: trimmed };
                    _setIgPresets(all);
                    populateIgPresetSelect();
                    const s = document.getElementById('ig-preset-select');
                    if (s && s.value === p.name) s.value = trimmed;
                    openIgManageModal();
                });
                const delBtn = row.querySelector('.api-preset-manage-btn--del');
                delBtn.addEventListener('click', () => {
                    if (!confirm('确定是否删除？')) return;
                    const updated = _getIgPresets().filter((item) => item.name !== p.name);
                    _setIgPresets(updated);
                    populateIgPresetSelect();
                    openIgManageModal();
                });
                list.appendChild(row);
            });
        }

        modal.style.display = 'flex';
        lockIgPresetModalBehindScroll();
    }

    function _getApiSettingsMainScrollEl() {
        const s = document.getElementById('api-settings-screen');
        return s && s.querySelector(':scope > .content');
    }

    let _igPresetModalScrollEl = null;
    let _igPresetModalScrollTop = 0;
    let _igPresetModalBodyLock = false;
    let _igPresetModalTouchBlock = null;

    function _onIgPresetModalTouchMove(e) {
        const list = document.getElementById('ig-preset-list');
        if (list && list.contains(e.target)) {
            return;
        }
        e.preventDefault();
    }

    function lockIgPresetModalBehindScroll() {
        if (_igPresetModalBodyLock) return;
        _igPresetModalBodyLock = true;
        const el = _getApiSettingsMainScrollEl();
        _igPresetModalScrollEl = el;
        if (el) {
            _igPresetModalScrollTop = el.scrollTop;
            el.classList.add('api-presets-modal-open-lock');
        }
        const modal = document.getElementById('ig-presets-modal');
        if (modal) {
            _igPresetModalTouchBlock = _onIgPresetModalTouchMove;
            modal.addEventListener('touchmove', _igPresetModalTouchBlock, { passive: false });
        }
    }

    function closeIgPresetManageModal() {
        const modal = document.getElementById('ig-presets-modal');
        if (modal) {
            if (_igPresetModalTouchBlock) {
                modal.removeEventListener('touchmove', _igPresetModalTouchBlock, { passive: false });
                _igPresetModalTouchBlock = null;
            }
            modal.style.display = 'none';
        }
        const el = _igPresetModalScrollEl;
        if (el) {
            el.classList.remove('api-presets-modal-open-lock');
            if (_igPresetModalBodyLock) {
                el.scrollTop = _igPresetModalScrollTop;
            }
        }
        _igPresetModalBodyLock = false;
        _igPresetModalScrollEl = null;
    }
    if (typeof window !== 'undefined') {
        window.closeIgPresetManageModal = closeIgPresetManageModal;
    }

    function _syncIgRefSlot(frame, preview) {
        if (!frame || !preview) return;
        const src = String(preview.getAttribute('src') || preview.src || '').trim();
        const has = src.length > 0 && (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http'));
        frame.dataset.hasImage = has ? 'true' : 'false';
    }

    function _syncAllIgRefSlots() {
        _syncIgRefSlot(
            document.getElementById('y2k-ig-ref-frame'),
            document.getElementById('setting-ig-ref-preview')
        );
        _syncIgRefSlot(
            document.getElementById('y2k-ig-style-ref-frame'),
            document.getElementById('setting-ig-style-ref-preview')
        );
        _syncIgRefSlot(
            document.getElementById('y2k-ig-body-ref-frame'),
            document.getElementById('setting-ig-body-ref-preview')
        );
    }

    /** 将角色生图相关字段填入聊天设置「生图」Tab */
    function loadCharImageGenToUI(chat) {
        if (!chat) return;
        const hint = (chat.imageGenNoRefHint != null && String(chat.imageGenNoRefHint).trim())
            ? chat.imageGenNoRefHint
            : (chat.imageAppearanceAnchor || '');
        _setVal('setting-ig-no-ref-hint', hint);

        const setPrev = (prevId, dataUrl) => {
            const prev = document.getElementById(prevId);
            if (!prev) return;
            if (dataUrl && String(dataUrl).startsWith('data:')) {
                prev.src = dataUrl;
            } else {
                prev.removeAttribute('src');
            }
        };
        setPrev('setting-ig-ref-preview', chat.imageGenRefDataUrl);
        setPrev('setting-ig-style-ref-preview', chat.imageGenStyleRefDataUrl);
        setPrev('setting-ig-body-ref-preview', chat.imageGenBodyRefDataUrl);
        _syncAllIgRefSlots();
    }

    function saveCharImageGenFromUI(chat) {
        if (!chat) return;
        chat.imageGenNoRefHint = String(_getVal('setting-ig-no-ref-hint') || '').trim();

        const readSlot = (previewId) => {
            const prev = document.getElementById(previewId);
            if (prev && prev.src && prev.src.startsWith('data:')) return prev.src;
            return '';
        };
        chat.imageGenRefDataUrl = readSlot('setting-ig-ref-preview');
        chat.imageGenStyleRefDataUrl = readSlot('setting-ig-style-ref-preview');
        chat.imageGenBodyRefDataUrl = readSlot('setting-ig-body-ref-preview');
    }

    /** 兼容旧代码：长框已废弃，读写到新字段时顺带保留旧键供迁移期读取 */
    function loadCharAnchorToUI(chat) { loadCharImageGenToUI(chat); }
    function saveCharAnchorFromUI(chat) { saveCharImageGenFromUI(chat); }

    let _charImageGenTabBound = false;

    function _bindCharRefSlot(slot) {
        const { file, choose, clearBtn, prev, frame } = slot;
        if (!file || !choose || !prev || !frame) return;
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
                prev.src = dataUrl;
                _syncIgRefSlot(frame, prev);
            } catch (err) {
                console.error('[ImageGen] ref file', err);
                if (typeof showToast === 'function') showToast('图片处理失败，请重试');
            }
        });
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                file.value = '';
                prev.removeAttribute('src');
                _syncIgRefSlot(frame, prev);
            });
        }
    }

    function initCharImageGenTab() {
        if (_charImageGenTabBound) return;
        const lockChoose = document.getElementById('setting-ig-ref-choose');
        if (!lockChoose) return;
        _charImageGenTabBound = true;
        _bindCharRefSlot({
            file: document.getElementById('setting-ig-ref-file'),
            choose: lockChoose,
            clearBtn: document.getElementById('setting-ig-ref-clear'),
            prev: document.getElementById('setting-ig-ref-preview'),
            frame: document.getElementById('y2k-ig-ref-frame')
        });
        _bindCharRefSlot({
            file: document.getElementById('setting-ig-style-ref-file'),
            choose: document.getElementById('setting-ig-style-ref-choose'),
            clearBtn: document.getElementById('setting-ig-style-ref-clear'),
            prev: document.getElementById('setting-ig-style-ref-preview'),
            frame: document.getElementById('y2k-ig-style-ref-frame')
        });
        _bindCharRefSlot({
            file: document.getElementById('setting-ig-body-ref-file'),
            choose: document.getElementById('setting-ig-body-ref-choose'),
            clearBtn: document.getElementById('setting-ig-body-ref-clear'),
            prev: document.getElementById('setting-ig-body-ref-preview'),
            frame: document.getElementById('y2k-ig-body-ref-frame')
        });
        _syncAllIgRefSlots();
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
                    const custom = _getIgTestPromptText();
                    const dataUrl = await generateImage(
                        custom || 'a beautiful sunset over the ocean, photo style'
                    );
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
                    const customPrompt = _getIgTestPromptText();
                    const dataUrl = await testReferenceImageWithFile(
                        f,
                        customPrompt || undefined
                    );
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

        const igSavePreset = document.getElementById('ig-save-preset');
        if (igSavePreset) {
            igSavePreset.addEventListener('click', () => saveIgPreset());
        }
        const igApplyPreset = document.getElementById('ig-apply-preset');
        if (igApplyPreset) {
            igApplyPreset.addEventListener('click', () => applyIgPreset());
        }
        const igManagePreset = document.getElementById('ig-manage-preset');
        if (igManagePreset) {
            igManagePreset.addEventListener('click', () => openIgManageModal());
        }
        const igPresetClose = document.getElementById('ig-preset-close');
        if (igPresetClose) {
            igPresetClose.addEventListener('click', () => closeIgPresetManageModal());
        }
        const igPresetModal = document.getElementById('ig-presets-modal');
        if (igPresetModal && !igPresetModal._igBackdropClickBound) {
            igPresetModal._igBackdropClickBound = true;
            igPresetModal.addEventListener('click', (e) => {
                if (e.target === igPresetModal) {
                    closeIgPresetManageModal();
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

    /** 设置页「测试用提示词」文本框，供文生/垫图测试与聊天里长文复现 */
    function _getIgTestPromptText() {
        const el = document.getElementById('ig-test-prompt');
        if (!el) return '';
        return String(el.value || '').trim();
    }

    return {
        isEnabled,
        extractScenePrompt,
        parsePhotoBlock,
        buildPrompt,
        buildImageGenPrompt,
        hasRefImage,
        hasStyleRefImage,
        hasBodyRefImage,
        pickCharacterRefForMode,
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
        populateIgPresetSelect,
        saveIgPreset,
        applyIgPreset,
        closeIgPresetManageModal,
        PHOTO_REGEX,
    };
})();

window.ImageGenModule = ImageGenModule;
window.fetchImageGenModels = (flag) => ImageGenModule.fetchAndPopulateImageModels(flag);
