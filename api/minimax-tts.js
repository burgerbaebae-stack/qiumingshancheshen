// api/minimax-tts.js

export default async function handler(req, res) {
    // 处理预检请求（OPTIONS），方便你日后本地或其他域调试
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
  
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
  
    try {
      // 允许前端自己传 apiUrl / apiKey / groupId / 其它参数
      const {
        apiUrl,
        apiKey,
        groupId,
        model,
        text,
        voiceId,
        speed,
      } = req.body || {};
  
      if (!apiUrl || !apiKey || !text) {
        return res.status(400).json({ error: 'apiUrl, apiKey, text 为必填参数' });
      }
  
      // 安全限制：只允许 MiniMax TTS 域名，防止被当作开放代理乱用
      try {
        const u = new URL(apiUrl);
        const allowedHosts = ['api.minimax.chat', 'api.minimax.io'];
        if (!allowedHosts.includes(u.hostname)) {
          return res.status(400).json({ error: '不允许转发到该域名' });
        }
      } catch {
        return res.status(400).json({ error: '无效的 apiUrl' });
      }
  
      // 构造 MiniMax 官方要求的请求体
      const upstreamBody = {
        model: model || 'speech-2.8-turbo',
        text,
        stream: false,
        output_format: 'hex',
        language_boost: 'auto',
        voice_setting: {
          voice_id: voiceId || 'male-qn-qingse',
          speed: speed !== undefined ? Number(speed) : 1.0,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
      };
  
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (groupId) {
        // 官方常用 GroupId Query 或 Header，这里用头部字段
        headers['GroupId'] = groupId;
      }
  
      const upstreamResp = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      });
  
      const textResp = await upstreamResp.text();
  
      // 透传状态码与内容
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(upstreamResp.status).send(textResp);
    } catch (e) {
      console.error('minimax-tts proxy error:', e);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(500).json({ error: e.message || 'Internal Server Error' });
    }
  }