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
                    
                    console.log(`Call started - Agent: ${agentId}, CallSid: ${callSid}`);
                    
                    const agentConfig = await fetchAgentConfig(agentId);
                    if (!agentConfig || !agentConfig.agent) {
                        console.error('Agent not found');
                        twilioWs.close();
                        return;
                    }

                    const agent = agentConfig.agent;
                    const knowledgeBase = agentConfig.knowledge_base || '';
                    
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
                                temperature: 0.8
                            }
                        };
                        openaiWs.send(JSON.stringify(sessionConfig));

                        if (agent.voice_greeting) {
                            const greetingEvent = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'message',
                                    role: 'assistant',
                                    content: [{
                                        type: 'input_text',
                                        text: agent.voice_greeting
                                    }]
                                }
                            };
                            openaiWs.send(JSON.stringify(greetingEvent));
                            openaiWs.send(JSON.stringify({ type: 'response.create' }));
                        }
                    });

                    openaiWs.on('message', (openaiMessage) => {
                        try {
                            const response = JSON.parse(openaiMessage);
                            
                            if (response.type === 'response.audio.delta' && response.delta) {
                                const audioMessage = {
                                    event: 'media',
                                    streamSid: streamSid,
                                    media: { payload: response.delta }
                                };
                                twilioWs.send(JSON.stringify(audioMessage));
                            }

                            if (response.type === 'response.audio_transcript.done') {
                                transcriptParts.push({ role: 'assistant', text: response.transcript });
                            }

                            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                                transcriptParts.push({ role: 'user', text: response.transcript });
                            }

                        } catch (err) {
                            console.error('OpenAI message parse error:', err);
                        }
                    });

                    openaiWs.on('error', (err) => {
                        console.error('OpenAI WebSocket error:', err);
                    });

                    openaiWs.on('close', () => {
                        console.log('OpenAI connection closed');
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
                        await saveTranscript(callSid, transcriptParts);
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
            await saveTranscript(callSid, transcriptParts);
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
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.json();
    } catch (err) {
        console.error('Error fetching agent config:', err);
        return null;
    }
}

async function saveTranscript(callSid, transcriptParts) {
    try {
        const transcript = transcriptParts.map(p => `${p.role}: ${p.text}`).join('\n');
        const response = await fetch(`${API_BASE_URL}/api/voice/save-transcript.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: API_KEY,
                call_sid: callSid,
                transcript: transcript
            })
        });
        console.log('Transcript saved for call:', callSid);
    } catch (err) {
        console.error('Error saving transcript:', err);
    }
}

server.listen(PORT, () => {
    console.log(`Voice WebSocket server running on port ${PORT}`);
});
