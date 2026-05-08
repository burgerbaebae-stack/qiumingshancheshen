/**
 * 烟测：内联与 theater.js 一致的抢救路径（裸 " 后结构对不齐则走漏串）
 * node scripts/theater-salvage-fallback-smoke.mjs
 */
function findTheaterBlocksArrayContentStart(s) {
    const m = /"blocks"\s*:\s*\[/.exec(String(s || ''));
    if (!m) return -1;
    return m.index + m[0].length;
}

function readJsonStringToken(s, q, lim) {
    let i = q;
    let out = '';
    while (i < lim) {
        const c = s[i];
        if (c === '\\') {
            if (i + 1 >= lim) return { text: out, end: i, leaked: true };
            const n = s[i + 1];
            if (n === 'n') out += '\n';
            else if (n === '"' || n === '\\') out += n;
            else out += n;
            i += 2;
            continue;
        }
        if (c === '"') return { text: out, end: i + 1, leaked: false };
        out += c;
        i++;
    }
    return { text: out, end: i, leaked: true };
}

function findLeakedTheaterTextEnd(s, from, lim) {
    const sub = s.slice(from, lim);
    const re = /\}\s*,\s*\{/g;
    let m;
    while ((m = re.exec(sub)) !== null) {
        const abs = from + m.index;
        const tail = s.slice(abs + m[0].length, Math.min(abs + m[0].length + 64, lim));
        if (/^\s*"type"\s*:/.test(tail)) return abs;
    }
    const rb = s.indexOf(']', from);
    if (rb >= 0 && rb < lim) return rb;
    return lim;
}

function sliceOneBlock(full, objStart, lim) {
    const head = full.slice(objStart, Math.min(objStart + 5000, lim));
    const textKm = /"text"\s*:\s*"/.exec(head);
    if (!textKm) return { textBody: null, next: objStart };
    const q = objStart + textKm.index + textKm[0].length;
    const textRead = readJsonStringToken(full, q, lim);
    let textBody;
    let next;

    let useLeakedPath = textRead.leaked;
    if (!useLeakedPath) {
        let jProbe = textRead.end;
        while (jProbe < lim && /\s/.test(full[jProbe])) jProbe++;
        if (jProbe >= lim || (full[jProbe] !== '}' && full[jProbe] !== ',')) {
            useLeakedPath = true;
        }
    }

    if (!useLeakedPath) {
        textBody = textRead.text.trim();
        let j = textRead.end;
        while (j < lim && /\s/.test(full[j])) j++;
        if (full[j] === '}') j++;
        while (j < lim && /\s/.test(full[j])) j++;
        if (full[j] === ',') j++;
        next = j;
    } else {
        const endBound = findLeakedTheaterTextEnd(full, q, lim);
        textBody = full.slice(q, endBound).trim().replace(/\}\s*$/, '').trim();
        if (full[endBound] === ']') {
            next = lim;
        } else {
            const commaBrace = full.indexOf('{', endBound + 1);
            next = commaBrace < 0 ? lim : commaBrace;
        }
    }
    return { textBody, next };
}

// 裸 ASCII " 夹在正文里：早闭串；旧逻辑只得到 "say "；回退后应捞到更多
const raw = '{"blocks":[{"type":"narration","text":"say "oops" tail is long here"}';
const full = raw.replace(/\r\n/g, '\n');
const arrStart = findTheaterBlocksArrayContentStart(full);
const lim = full.length;
const p = arrStart;
const { textBody, next } = sliceOneBlock(full, p, lim);

if (!textBody || !textBody.includes('tail is long')) {
    throw new Error(`fallback smoke fail: got ${JSON.stringify(textBody)} next=${next}`);
}

// 对照：若强制走「早闭」路径（不探测 jProbe），text 只会是 say 
const tr = readJsonStringToken(full, /"text"\s*:\s*"/.exec(full.slice(p, p + 200)).index + p + '"text":"'.length, lim);
if (tr.leaked) throw new Error('unexpected leaked for control');
let j = tr.end;
while (j < lim && /\s/.test(full[j])) j++;
if (full[j] === '}' || full[j] === ',') {
    throw new Error('control fixture should have broken structure after fake close');
}

console.log('theater-salvage-fallback-smoke: ok');
