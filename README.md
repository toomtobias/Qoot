# Multiplayer Quiz

Real-time multiplayer quiz application built with Node.js, Express, and Socket.io.

## Features

- AI-generated quiz questions (placeholder - ready for OpenAI/xAI integration)
- Real-time multiplayer with Socket.io
- Host can edit questions before starting
- 30-second timer per question (server-controlled)
- Live scoring and leaderboard
- Export/import quiz as JSON
- No database - all data in memory

## Quick Start

```bash
# Install dependencies
npm install

# Start server
npm start

# Or with auto-reload during development
npm run dev
```

Open http://localhost:3000 in your browser.

## How to Play

### As Host

1. Go to http://localhost:3000
2. Enter a prompt like "Ett quiz om svensk historia" and click "Generera frågor"
3. Review and edit the questions if needed
4. Click "Starta quiz" to create a session
5. Share the player link with participants
6. Wait for players to join, then click "Starta quiz"

### As Player

1. Open the link shared by the host (e.g., http://localhost:3000/quiz/abc123)
2. Enter your name and join
3. Answer questions within the time limit
4. See your score after each question
5. View the final podium at the end

## Example AI Prompt

```
Skapa ett quiz med 5 frågor om:
- Svensk geografi
- Mellannivå svårighetsgrad
- Fyra svarsalternativ per fråga
```

## JSON Format

Export/import quizzes using this format:

```json
{
  "questions": [
    {
      "question": "Vad är Sveriges huvudstad?",
      "options": ["Göteborg", "Stockholm", "Malmö", "Uppsala"],
      "correctIndex": 1
    }
  ]
}
```

## AI Integration

The file `server.js` contains a placeholder function `generateQuizFromAI()` that returns example questions. To integrate with OpenAI:

1. Install the OpenAI SDK: `npm install openai`
2. Set your API key: `export OPENAI_API_KEY=your-key`
3. Replace the placeholder in `server.js` with actual API calls

See the comments in `server.js` for example implementation.

## Tech Stack

- **Backend**: Node.js, Express, Socket.io v4
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **No database**: All data stored in memory

## File Structure

```
quiz/
├── server.js           # Express + Socket.io server
├── package.json        # Dependencies and scripts
├── README.md           # This file
└── public/
    ├── index.html      # Create quiz page
    ├── host.html       # Host view (lobby, questions, results)
    ├── player.html     # Player view (join, play, podium)
    └── style.css       # Shared styles
```

## Notes

- Sessions are stored in memory and lost on server restart
- Sessions are automatically cleaned up 1 minute after quiz ends
- Host disconnecting ends the session for all players
- Players cannot join after quiz has started
