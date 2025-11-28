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
            
            // Check previous assistant message for context
            const prevText = i > 0 ? (transcriptParts[i-1]?.text?.toLowerCase() || '') : '';
            
            // Name extraction - after "who am I speaking with" or similar
            if (prevText.includes('speaking with') || prevText.includes('your name') || prevText.includes('may i ask who')) {
                const cleaned = text.replace(/^(my name is |i'm |this is |it's |i am )/i, '').replace(/[.,!?]/g, '').trim();
                const nameParts = cleaned.split(' ');
                if (nameParts.length >= 1 && nameParts[0].length > 1) {
                    leadData.first_name = nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1).toLowerCase();
                    if (nameParts.length >= 2) {
                        leadData.last_name = nameParts.slice(1).map(n => n.charAt(0).toUpperCase() + n.slice(1).toLowerCase()).join(' ');
                    }
                }
            }
            
            // Company extraction - "I'm with X" or "from X" or after company question
            const companyMatch = text.match(/(?:i'm with|i am with|from|at|work for|company is|business is)\s+(.+?)(?:\.|,|and|$)/i);
            if (companyMatch && companyMatch[1].length > 1 && companyMatch[1].length < 50) {
                leadData.company = companyMatch[1].trim();
            }
            if (prevText.includes('company') || prevText.includes('business')) {
                if (!textLower.includes('no ') && text.length > 1 && text.length < 50) {
                    leadData.company = leadData.company || text.replace(/[.,!?]/g, '').trim();
                }
            }
            
            // Phone extraction
            const phoneMatch = text.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
            if (phoneMatch) {
                leadData.phone = phoneMatch[1].replace(/[^\d+]/g, '');
            }
            
            // Email extraction
            const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/i);
            if (emailMatch) {
                leadData.email = emailMatch[0].toLowerCase();
            }
        }
    }
    
    console.log('Extracted lead data:', leadData);
    return leadData;
}
                    if (!text.toLowerCase().includes('no ') && text.length < 100) {
                        leadData.company = text.trim();
                    }
                }
            }
        }
    }
    
    return leadData;
}

wss.on('connection', async (twilioWs, req) => {
    console.log('New Twilio connection');

    let openaiWs = null;
    let streamSid = null;
    let agentId = null;
    let callSid = null;
    let transcriptParts = [];

    twilioWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    const customParams = data.start.customParameters || {};
                    agentId = customParams.agent_id;
                    callSid = customParams.call_sid;

                    console.log(`Call started - Agent: ${agentId}, CallSid: ${callSid}, StreamSid: ${streamSid}`);

                    const agentConfig = await fetchAgentConfig(agentId);
                    if (!agentConfig || !agentConfig.agent) {
                        console.error('Agent not found');
                        twilioWs.close();
                        return;
                    }

                    const agent = agentConfig.agent;
                    const knowledgeBase = agentConfig.knowledge_base || '';

                    console.log('Agent loaded:', agent.agent_name, 'Voice:', agent.voice_id);

                    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                        headers: {
                            'Authorization': `Bearer ${OPENAI_API_KEY}`,
                            'OpenAI-Beta': 'realtime=v1'
                        }
                    });

                    openaiWs.on('open', () => {
                        console.log('Connected to OpenAI Realtime API');

                        let systemPrompt = agent.system_prompt || 'You are a helpful assistant.';
                        if (knowledgeBase) {
                            systemPrompt += '\n\nKnowledge Base:\n' + knowledgeBase;
                        }

                        const sessionConfig = {
                            type: 'session.update',
                            session: {
                                turn_detection: { type: 'server_vad' },
                                input_audio_format: 'g711_ulaw',
                                output_audio_format: 'g711_ulaw',
                                voice: agent.voice_id || 'alloy',
                                instructions: systemPrompt,
                                modalities: ['text', 'audio'],
                                temperature: 0.8,
                                input_audio_transcription: {
                                    model: 'whisper-1'
                                }
                            }
                        };
                        openaiWs.send(JSON.stringify(sessionConfig));
                        console.log('Session config sent with voice:', agent.voice_id);
                    });

                    openaiWs.on('message', (openaiMessage) => {
                        try {
                            const response = JSON.parse(openaiMessage);

                            if (response.type === 'session.created') {
                                console.log('Session created');
                            }

                            if (response.type === 'session.updated') {
                                console.log('Session updated, sending greeting...');
                                if (agent.voice_greeting) {
                                    const greetingEvent = {
                                        type: 'conversation.item.create',
                                        item: {
                                            type: 'message',
                                            role: 'user',
                                            content: [{
                                                type: 'input_text',
                                                text: 'Please greet the caller with: ' + agent.voice_greeting
                                            }]
                                        }
                                    };
                                    openaiWs.send(JSON.stringify(greetingEvent));
                                    openaiWs.send(JSON.stringify({ type: 'response.create' }));
                                    console.log('Greeting request sent');
                                }
                            }

                            if (response.type === 'error') {
                                console.error('OpenAI error:', JSON.stringify(response.error));
                            }

                            if (response.type === 'response.audio.delta' && response.delta) {
                                const audioMessage = {
                                    event: 'media',
                                    streamSid: streamSid,
                                    media: { payload: response.delta }
                                };
                                twilioWs.send(JSON.stringify(audioMessage));
                            }

                            if (response.type === 'response.audio_transcript.done') {
                                console.log('Assistant said:', response.transcript);
                                transcriptParts.push({ role: 'assistant', text: response.transcript });
                            }

                            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                                console.log('User said:', response.transcript);
                                transcriptParts.push({ role: 'user', text: response.transcript });
                            }

                        } catch (err) {
                            console.error('OpenAI message parse error:', err);
                        }
                    });

                    openaiWs.on('error', (err) => {
                        console.error('OpenAI WebSocket error:', err.message);
                    });

                    openaiWs.on('close', (code, reason) => {
                        console.log('OpenAI connection closed, code:', code);
                    });

                    break;

                case 'media':
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioEvent = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openaiWs.send(JSON.stringify(audioEvent));
                    }
                    break;

                case 'stop':
                    console.log('Call ended');
                    if (callSid && transcriptParts.length > 0) {
                        const leadData = extractLeadData(transcriptParts);
                        console.log('Extracted lead data:', leadData);
                        await saveTranscript(callSid, transcriptParts, leadData);
                    }
                    if (openaiWs) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (err) {
            console.error('Twilio message error:', err);
        }
    });

    twilioWs.on('close', async () => {
        console.log('Twilio connection closed');
        if (callSid && transcriptParts.length > 0) {
            const leadData = extractLeadData(transcriptParts);
            console.log('Extracted lead data:', leadData);
            await saveTranscript(callSid, transcriptParts, leadData);
        }
        if (openaiWs) {
            openaiWs.close();
        }
    });

    twilioWs.on('error', (err) => {
        console.error('Twilio WebSocket error:', err);
    });
});

async function fetchAgentConfig(agentId) {
    try {
        const url = `${API_BASE_URL}/api/voice/agent-config.php?agent_id=${agentId}&key=${API_KEY}`;
        console.log('Fetching agent config from:', url);
        const response = await fetch(url);
        if (!response.ok) {
            console.error('Agent config response not ok:', response.status);
            return null;
        }
        return await response.json();
    } catch (err) {
        console.error('Error fetching agent config:', err);
        return null;
    }
}

async function saveTranscript(callSid, transcriptParts, leadData = {}) {
    try {
        const transcript = transcriptParts.map(p => `${p.role}: ${p.text}`).join('\n');
        const response = await fetch(`${API_BASE_URL}/api/voice/save-transcript.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: API_KEY,
                call_sid: callSid,
                transcript: transcript,
                lead_data: leadData
            })
        });
        const result = await response.json();
        console.log('Transcript saved for call:', callSid, result);
    } catch (err) {
        console.error('Error saving transcript:', err);
    }
}

server.listen(PORT, () => {
    console.log(`Voice WebSocket server running on port ${PORT}`);
});
