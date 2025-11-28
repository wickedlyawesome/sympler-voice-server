const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://app.symplercms.com';
const API_KEY = 'sympler_voice_2024_secret';

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sympler Voice Server Running');
});

const wss = new WebSocket.Server({ server });

console.log('Voice WebSocket server starting...');

function extractLeadData(transcriptParts) {
    const leadData = {};
    for (let i = 0; i < transcriptParts.length; i++) {
        const part = transcriptParts[i];
        if (part.role === 'user') {
            const text = part.text.trim();
            const textLower = text.toLowerCase();
            const prevText = i > 0 ? (transcriptParts[i-1]?.text?.toLowerCase() || '') : '';
            if (prevText.includes('speaking with') || prevText.includes('your name')) {
                const cleaned = text.replace(/^(my name is |i'm |this is |i am )/i, '').replace(/[.,!?]/g, '').trim();
                const nameParts = cleaned.split(' ');
                if (nameParts.length >= 1 && nameParts[0].length > 1) {
                    leadData.first_name = nameParts[0];
                    if (nameParts.length >= 2) leadData.last_name = nameParts.slice(1).join(' ');
                }
            }
            const companyMatch = text.match(/(?:i'm with|i am with|from|at|work for)\s+(.+?)(?:\.|,|and|$)/i);
            if (companyMatch) leadData.company = companyMatch[1].trim();
            const phoneMatch = text.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
            if (phoneMatch) leadData.phone = phoneMatch[1];
            const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/i);
            if (emailMatch) leadData.email = emailMatch[0];
        }
    }
    return leadData;
}

wss.on('connection', async (twilioWs) => {
    console.log('New Twilio connection');
    let openaiWs = null, streamSid = null, agentId = null, callSid = null, transcriptParts = [];

    twilioWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    agentId = data.start.customParameters?.agent_id;
                    callSid = data.start.customParameters?.call_sid;
                    console.log(`Call started - Agent: ${agentId}, CallSid: ${callSid}`);
                    const agentConfig = await fetchAgentConfig(agentId);
                    if (!agentConfig?.agent) { twilioWs.close(); return; }
                    const agent = agentConfig.agent;
                    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
                    });
                    openaiWs.on('open', () => {
                        console.log('Connected to OpenAI');
                        openaiWs.send(JSON.stringify({
                            type: 'session.update',
                            session: {
                                turn_detection: { type: 'server_vad' },
                                input_audio_format: 'g711_ulaw',
                                output_audio_format: 'g711_ulaw',
                                voice: agent.voice_id || 'alloy',
                                instructions: agent.system_prompt || 'You are a helpful assistant.',
                                modalities: ['text', 'audio'],
                                temperature: 0.8,
                                input_audio_transcription: { model: 'whisper-1' }
                            }
                        }));
                    });
                    openaiWs.on('message', (msg) => {
                        try {
                            const r = JSON.parse(msg);
                            if (r.type === 'session.updated' && agent.voice_greeting) {
                                openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: agent.voice_greeting }] } }));
                                openaiWs.send(JSON.stringify({ type: 'response.create' }));
                            }
                            if (r.type === 'response.audio.delta' && r.delta) {
                                twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: r.delta } }));
                            }
                            if (r.type === 'response.audio_transcript.done') transcriptParts.push({ role: 'assistant', text: r.transcript });
                            if (r.type === 'conversation.item.input_audio_transcription.completed') transcriptParts.push({ role: 'user', text: r.transcript });
                        } catch (e) { console.error('OpenAI parse error:', e); }
                    });
                    openaiWs.on('error', (e) => console.error('OpenAI error:', e.message));
                    openaiWs.on('close', () => console.log('OpenAI closed'));
                    break;
                case 'media':
                    if (openaiWs?.readyState === WebSocket.OPEN) {
                        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
                    }
                    break;
                case 'stop':
                    console.log('Call ended');
                    if (callSid && transcriptParts.length > 0) await saveTranscript(callSid, transcriptParts, extractLeadData(transcriptParts));
                    openaiWs?.close();
                    break;
            }
        } catch (e) { console.error('Message error:', e); }
    });
    twilioWs.on('close', async () => {
        if (callSid && transcriptParts.length > 0) await saveTranscript(callSid, transcriptParts, extractLeadData(transcriptParts));
        openaiWs?.close();
    });
});

async function fetchAgentConfig(agentId) {
    try {
        const r = await fetch(`${API_BASE_URL}/api/voice/agent-config.php?agent_id=${agentId}&key=${API_KEY}`);
        return r.ok ? await r.json() : null;
    } catch (e) { console.error('Fetch error:', e); return null; }
}

async function saveTranscript(callSid, parts, leadData) {
    try {
        await fetch(`${API_BASE_URL}/api/voice/save-transcript.php`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: API_KEY, call_sid: callSid, transcript: parts.map(p => `${p.role}: ${p.text}`).join('\n'), lead_data: leadData })
        });
        console.log('Saved:', callSid);
    } catch (e) { console.error('Save error:', e); }
}

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
