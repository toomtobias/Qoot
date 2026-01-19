/**
 * Multiplayer Quiz Server
 * Real-time quiz application using Express + Socket.io
 * All data stored in memory (no database)
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// IN-MEMORY STORAGE
// All data is lost when the server restarts
// ============================================
const sessions = new Map(); // sessionId -> SessionData

/**
 * Session data structure:
 * {
 *   id: string,
 *   name: string,
 *   hostSocketId: string,
 *   questions: [{ question: string, options: string[], correctIndex: number }],
 *   players: Map<socketId, { name: string, score: number, currentAnswer: number | null }>,
 *   status: 'lobby' | 'playing' | 'finished',
 *   currentQuestionIndex: number,
 *   timer: NodeJS.Timeout | null,
 *   timeLeft: number
 * }
 */

// ============================================
// GROK AI INTEGRATION (xAI)
// Using Grok 4.1 Fast for quiz generation
// ============================================
const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';

async function generateQuizFromAI(prompt) {
  if (!XAI_API_KEY) {
    console.error('[Grok] API key not configured');
    throw new Error('AI service not configured');
  }

  console.log(`[Grok] Generating quiz for prompt: "${prompt}"`);

  const systemPrompt = `You are a quiz generator. Create a quiz based on the user's request.

IMPORTANT RULES:
- Generate exactly 10 questions unless the user specifies a different number
- Each question must have exactly 4 answer options
- Exactly one option must be correct per question. Make sure not all questions have the same correct option index
- Questions should be clear and concise
- Avoid ambiguous or tricky questions
- Also generate a catchy quiz name (3-8 words) based on the topic
- Return ONLY valid JSON, no markdown, no code blocks
- The JSON must be an object with a "name" field and a "questions" array
- Each question object must have: "question" (string), "options" (array of 4 strings), "correctIndex" (0-3)
- Always answer in Swedish

Example format:
{"name":"Svenska Historiens Höjdpunkter","questions":[{"question":"Vad är 2+2?","options":["3","4","5","6"],"correctIndex":1}]}`;

  try {
    const response = await fetch(XAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'grok-4-fast',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Grok] API error: ${response.status}`, errorText);
      throw new Error(`Grok API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No content in response');
    }

    // Parse the JSON response
    let parsed;
    try {
      // Try to extract JSON if it's wrapped in markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      parsed = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('[Grok] Failed to parse response:', content);
      throw new Error('Invalid JSON response from AI');
    }

    const name = parsed.name || 'Quiz';
    const questions = parsed.questions || parsed;

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('No questions in response');
    }

    // Validate question format
    for (const q of questions) {
      if (!q.question || !Array.isArray(q.options) || q.options.length !== 4 || typeof q.correctIndex !== 'number') {
        throw new Error('Invalid question format');
      }
    }

    console.log(`[Grok] Generated ${questions.length} questions`);
    return { name, questions };

  } catch (error) {
    console.error('[Grok] Error:', error.message);
    throw error;
  }
}

// ============================================
// REST API ENDPOINTS
// ============================================

// Generate quiz from AI (placeholder)
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    const { name, questions } = await generateQuizFromAI(prompt);
    res.json({ name, questions });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz' });
  }
});

// Create new session
app.post('/api/session', (req, res) => {
  try {
    const { name, questions } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions array is required' });
    }

    const sessionId = uuidv4().slice(0, 8); // Short ID for easier sharing
    const sanitizedName = (name || 'Quiz').trim().substring(0, 100);

    sessions.set(sessionId, {
      id: sessionId,
      name: sanitizedName,
      hostSocketId: null,
      questions,
      players: new Map(),
      status: 'lobby',
      currentQuestionIndex: 0,
      timer: null,
      timeLeft: 0
    });

    console.log(`[Session] Created: ${sessionId}`);
    res.json({ sessionId });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Get session data (for reconnection)
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Return safe session data (without answers for players)
  res.json({
    id: session.id,
    status: session.status,
    questionCount: session.questions.length,
    playerCount: session.players.size
  });
});

// Export quiz as JSON
app.get('/api/session/:id/export', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    name: session.name,
    questions: session.questions,
    exportedAt: new Date().toISOString()
  });
});

// Import quiz from JSON (creates new session)
app.post('/api/import', (req, res) => {
  try {
    const { name, questions } = req.body;
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Valid questions array required' });
    }

    // Validate question format
    for (const q of questions) {
      if (!q.question || !Array.isArray(q.options) || typeof q.correctIndex !== 'number') {
        return res.status(400).json({ error: 'Invalid question format' });
      }
    }

    const sessionId = uuidv4().slice(0, 8);
    const sanitizedName = (name || 'Importerat Quiz').trim().substring(0, 100);

    sessions.set(sessionId, {
      id: sessionId,
      name: sanitizedName,
      hostSocketId: null,
      questions,
      players: new Map(),
      status: 'lobby',
      currentQuestionIndex: 0,
      timer: null,
      timeLeft: 0
    });

    console.log(`[Session] Imported: ${sessionId}`);
    res.json({ sessionId });
  } catch (error) {
    console.error('Error importing quiz:', error);
    res.status(500).json({ error: 'Failed to import quiz' });
  }
});

// Serve create quiz page
app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});

// Serve host page
app.get('/host/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// Serve player page
app.get('/quiz/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Host joins session
  socket.on('host:join', (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    session.hostSocketId = socket.id;
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.isHost = true;

    // Send current session state to host
    socket.emit('host:session', {
      id: session.id,
      name: session.name,
      questions: session.questions,
      players: Array.from(session.players.values()).map(p => ({ name: p.name, score: p.score })),
      status: session.status
    });

    console.log(`[Host] Joined session: ${sessionId}`);
  });

  // Player joins session
  socket.on('player:join', ({ sessionId, playerName }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // Check if player is already in this session (reconnect scenario)
    const existingPlayer = Array.from(session.players.values()).find(p => p.name.toLowerCase() === playerName.toLowerCase());
    const isReconnect = existingPlayer !== undefined;

    if (session.status !== 'lobby' && !isReconnect) {
      socket.emit('error', { message: 'Quiz has already started' });
      return;
    }

    if (!isReconnect) {
      // New player joining during lobby phase
      // Check for duplicate names
      const existingNames = Array.from(session.players.values()).map(p => p.name.toLowerCase());
      if (existingNames.includes(playerName.toLowerCase())) {
        socket.emit('error', { message: 'Namnet är redan taget, välj ett annat' });
        return;
      }

      // Add new player to session
      session.players.set(socket.id, {
        name: playerName,
        score: 0,
        currentAnswer: null
      });
      console.log(`[Player] ${playerName} joined session: ${sessionId}`);
    } else {
      // Player is reconnecting - update their socket id but keep their data
      const oldSocketId = Array.from(session.players.entries()).find(([_, p]) => p.name.toLowerCase() === playerName.toLowerCase())[0];
      const playerData = session.players.get(oldSocketId);
      session.players.delete(oldSocketId);
      session.players.set(socket.id, playerData);
      console.log(`[Player] ${playerName} reconnected to session: ${sessionId}`);
    }

    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.isHost = false;
    socket.playerName = playerName;

    // Notify all in room about player list
    const playerList = Array.from(session.players.values()).map(p => ({ name: p.name, score: p.score }));
    io.to(sessionId).emit('lobby:players', {
      quizName: session.name,
      players: playerList
    });
  });

  // Host starts the quiz
  socket.on('host:start', (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session || socket.id !== session.hostSocketId) {
      socket.emit('error', { message: 'Not authorized' });
      return;
    }

    if (session.players.size === 0) {
      socket.emit('error', { message: 'Need at least one player' });
      return;
    }

    // Set time limit (default 30 seconds, min 5, max 120)
    const timeLimit = data?.timeLimit || 30;
    session.timeLimit = Math.min(Math.max(timeLimit, 5), 120);

    session.status = 'playing';
    session.currentQuestionIndex = 0;

    // Reset all player answers
    for (const player of session.players.values()) {
      player.currentAnswer = null;
      player.answerTime = null;
    }

    console.log(`[Quiz] Started: ${session.id} with ${session.timeLimit}s per question`);
    sendQuestion(session);
  });

  // Player submits answer
  socket.on('player:answer', (answerIndex) => {
    const session = sessions.get(socket.sessionId);
    if (!session || session.status !== 'playing') return;

    const player = session.players.get(socket.id);
    if (!player) return;

    // Only record time on first answer (can't improve time by changing answer)
    if (player.currentAnswer === null) {
      player.answerTime = session.timeLeft;
    }
    player.currentAnswer = answerIndex;
    console.log(`[Answer] ${player.name} answered: ${answerIndex} (${player.answerTime}s left)`);

    // Notify all about answer count
    const answeredCount = Array.from(session.players.values()).filter(p => p.currentAnswer !== null).length;
    io.to(socket.sessionId).emit('host:answerCount', {
      answered: answeredCount,
      total: session.players.size
    });

    // Calculate answer statistics for host display
    const answerStats = [0, 0, 0, 0]; // Count for each option A, B, C, D
    for (const player of session.players.values()) {
      if (player.currentAnswer !== null) {
        answerStats[player.currentAnswer]++;
      }
    }

    // Send answer statistics only to host
    io.to(session.hostSocketId).emit('host:answerStats', {
      stats: answerStats
    });
  });

  // Host skips to next question (optional)
  socket.on('host:skip', () => {
    const session = sessions.get(socket.sessionId);
    if (!session || socket.id !== session.hostSocketId) return;

    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    endQuestion(session);
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    if (socket.isHost) {
      // Host disconnected - end session
      if (session.timer) clearInterval(session.timer);
      io.to(socket.sessionId).emit('session:ended', { reason: 'Host disconnected' });
      sessions.delete(socket.sessionId);
      console.log(`[Session] Ended (host left): ${socket.sessionId}`);
    } else {
      // Player disconnected
      session.players.delete(socket.id);
      const playerList = Array.from(session.players.values()).map(p => ({ name: p.name, score: p.score }));
      io.to(socket.sessionId).emit('lobby:players', {
        quizName: session.name,
        players: playerList
      });
      console.log(`[Player] ${socket.playerName} left session: ${socket.sessionId}`);
    }
  });
});

// ============================================
// GAME LOGIC FUNCTIONS
// ============================================

function sendQuestion(session) {
  const question = session.questions[session.currentQuestionIndex];
  const questionNumber = session.currentQuestionIndex + 1;
  const totalQuestions = session.questions.length;

  // Reset answers for new question
  for (const player of session.players.values()) {
    player.currentAnswer = null;
    player.answerTime = null;
  }

  // Get time limit (default to 30 if not set)
  const timeLimit = session.timeLimit || 30;

  // Send question to all (without correct answer)
  io.to(session.id).emit('quiz:question', {
    questionNumber,
    totalQuestions,
    question: question.question,
    options: question.options,
    timeLimit,
    totalPlayers: session.players.size
  });

  // Send correct answer only to host
  io.to(session.hostSocketId).emit('host:correctAnswer', {
    correctIndex: question.correctIndex
  });

  // Start countdown timer (server-controlled)
  session.timeLeft = timeLimit;

  session.timer = setInterval(() => {
    session.timeLeft--;
    io.to(session.id).emit('quiz:timer', { timeLeft: session.timeLeft });

    if (session.timeLeft <= 0) {
      clearInterval(session.timer);
      session.timer = null;
      endQuestion(session);
    }
  }, 1000);
}

function endQuestion(session) {
  const question = session.questions[session.currentQuestionIndex];
  const results = [];
  const TIME_LIMIT = session.timeLimit || 30;
  const MAX_POINTS = 1000;
  const MIN_POINTS = 500; // Minimum points for correct answer

  // Calculate points for this question (faster = more points)
  for (const [socketId, player] of session.players) {
    const isCorrect = player.currentAnswer === question.correctIndex;
    let pointsEarned = 0;

    if (isCorrect && player.answerTime !== null) {
      // Points based on speed: 500-1000 depending on how fast
      const timeBonus = (player.answerTime / TIME_LIMIT) * (MAX_POINTS - MIN_POINTS);
      pointsEarned = Math.round(MIN_POINTS + timeBonus);
    }

    player.score += pointsEarned;

    results.push({
      name: player.name,
      answer: player.currentAnswer,
      isCorrect,
      pointsEarned,
      totalScore: player.score,
      answerTime: player.answerTime
    });
  }

  // Sort by total score
  results.sort((a, b) => b.totalScore - a.totalScore);

  // Send results to all
  io.to(session.id).emit('quiz:results', {
    correctIndex: question.correctIndex,
    correctAnswer: question.options[question.correctIndex],
    playerResults: results
  });

  // Check if there are more questions
  session.currentQuestionIndex++;
  const isLastQuestion = session.currentQuestionIndex >= session.questions.length;

  // Start countdown for next question (5 seconds)
  let countdownLeft = 5;
  const countdownInterval = setInterval(() => {
    io.to(session.id).emit('quiz:countdown', {
      timeLeft: countdownLeft,
      isLastQuestion
    });
    countdownLeft--;

    if (countdownLeft < 0) {
      clearInterval(countdownInterval);

      if (isLastQuestion) {
        endQuiz(session);
      } else {
        if (session.status === 'playing') {
          sendQuestion(session);
        }
      }
    }
  }, 1000);
}

function endQuiz(session) {
  session.status = 'finished';

  // Get final standings
  const standings = Array.from(session.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  // Podium (top 3)
  const podium = standings.slice(0, 3).map((player, index) => ({
    position: index + 1,
    name: player.name,
    score: player.score
  }));

  io.to(session.id).emit('quiz:finished', {
    podium,
    allResults: standings
  });

  console.log(`[Quiz] Finished: ${session.id}`);

  // Clean up session after 1 minute
  setTimeout(() => {
    if (sessions.has(session.id)) {
      sessions.delete(session.id);
      console.log(`[Session] Cleaned up: ${session.id}`);
    }
  }, 60000);
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quiz server running on http://localhost:${PORT}`);
});
